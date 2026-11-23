import { browserRequestHeaders } from "../../network/service_identity";
import { readResponseBody } from "../../network/bounded_fetch";
import { fetchThroughPublicRedirects, PublicRedirectError } from "../../network/public_redirects";
import { errorText } from "../../util/error_text";
import { emailRoute } from "../providers/submission_routes";
import { contactChainProvenance } from "../resolver/contact_chain";
import { fetchRegistrarRdap } from "../resolver/domain";
import { fetchRdapRecord } from "../resolver/http";
import { queryPort43 } from "../resolver/port43";
import { domainHolderContacts, explicitAbuseMailboxes, extractPort43, firstEntityWithRole, type DomainHolderContact } from "../resolver/rdap";
import { unroutableRoute } from "../resolver/routes";
import type { AbuseMailbox, JsonRecord, ResolvedAbuseTarget, ResolverDependencies, ResolverTarget } from "../resolver/types";
import { businessSite } from "./chain";
import { contactPageLinks, htmlEmails, isPrivacyPlaceholder, mailboxRank, securityTxtEmails, whoisHolder, type ContactSource, type SiteContact } from "./contacts";
import { parseFunnelPartyTarget } from "./target";
import { FUNNEL_PLATFORM_VENDORS, type PlatformVendor } from "./vendors";

const PAGE_TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
/** The home page and security.txt, plus at most this many linked or well-known pages. */
const MAX_LINKED_PAGES = 6;
const WELL_KNOWN_PAGES = ["/contact", "/contact-us", "/affiliates", "/terms"];
const SOURCE_ORDER: readonly ContactSource[] = ["security_txt", "website", "holder_rdap", "holder_whois", "platform_vendor"];

/** What the search for a business's contacts found, and what it consulted. */
export type SiteContactSearch = {
	site: string;
	/** Suitable mailboxes, best first. */
	contacts: SiteContact[];
	/** The organization the domain registration names, when it is not a privacy service. */
	holder?: string;
	/** The registration hides its holder behind a privacy service or the registrar. */
	redacted: boolean;
	checked: string[];
	/** Lookups that failed rather than finding nothing (a timeout, HTTP 5xx or 429); the search is worth repeating. */
	failures: string[];
};

type Page = { url: string; body: string };

/** A failure the next attempt may not have: a timeout, a reset connection, an overloaded server. */
function isTransient(error: unknown): boolean {
	return /time(?:d)?[\s-]?out|abort|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|network/i.test(errorText(error));
}

async function fetchPage(url: string, site: string, dependencies: ResolverDependencies, search: Pick<SiteContactSearch, "checked" | "failures">): Promise<Page | undefined> {
	search.checked.push(url);
	try {
		const { response, urls } = await fetchThroughPublicRedirects(url, {
			...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
			...(dependencies.assertPublicHost ? { assertPublicHost: dependencies.assertPublicHost } : {}),
			subject: "contact page",
			headers: { ...browserRequestHeaders },
			maxRedirects: MAX_REDIRECTS,
			timeoutMs: dependencies.httpTimeoutMs ?? PAGE_TIMEOUT_MS,
		});
		const finalUrl = urls.at(-1) ?? url;
		const type = response.headers.get("content-type") ?? "";
		// A page that moved to another business publishes that business's contacts.
		if (!response.ok || businessSite(new URL(finalUrl).hostname) !== site || (type && !/text\/|html|xml/i.test(type))) {
			await response.body?.cancel().catch(() => undefined);
			if (response.status === 429 || response.status >= 500) search.failures.push(`${url}: HTTP ${response.status}`);
			return undefined;
		}
		return { url: finalUrl, body: (await readResponseBody(response, MAX_PAGE_BYTES)).toString("utf8") };
	} catch (error) {
		const cause = error instanceof PublicRedirectError ? error.cause : error;
		if (isTransient(cause)) search.failures.push(`${url}: ${errorText(cause)}`);
		return undefined;
	}
}

type Registration = { contacts: SiteContact[]; holder?: string; redacted: boolean };

/**
 * The holder contacts of the site's domain registration that are the
 * holder's own: registrant, administrative and technical contacts from the
 * registry's and the registrar's RDAP record, or from port-43 WHOIS when RDAP
 * names none. A privacy service's placeholder or a forwarding address at the
 * registrar is not the holder's.
 */
async function registrationContacts(site: string, dependencies: ResolverDependencies, search: Pick<SiteContactSearch, "checked" | "failures">): Promise<Registration> {
	let record: JsonRecord | undefined;
	try {
		search.checked.push(`RDAP domain ${site}`);
		record = await fetchRdapRecord("domain", site, dependencies);
	} catch (error) {
		search.failures.push(`RDAP domain ${site}: ${errorText(error)}`);
	}
	const registrar = record ? await fetchRegistrarRdap(record, dependencies) : {};
	if (registrar.url) search.checked.push(registrar.url);
	if (registrar.error && registrar.error !== "not_found") search.failures.push(`${registrar.url}: ${registrar.error}`);
	const registrarDomains = [record, registrar.record]
		.flatMap((root) => explicitAbuseMailboxes(firstEntityWithRole(root, "registrar"), "registrar_rdap"))
		.map(({ email }) => businessSite(email.slice(email.lastIndexOf("@") + 1)));
	let holders: Array<DomainHolderContact & { source: ContactSource; foundAt: string }> = [...domainHolderContacts(record), ...domainHolderContacts(registrar.record)]
		.map((holder) => ({ ...holder, source: "holder_rdap", foundAt: registrar.url ?? `RDAP domain ${site}` }));
	if (!holders.some(({ emails }) => emails.length)) {
		const server = extractPort43(registrar.record) ?? extractPort43(record);
		if (server) search.checked.push(`WHOIS ${server}`);
		const whois = await queryPort43(server, site, dependencies);
		if (whois.error) search.failures.push(`WHOIS ${server}: ${whois.error}`);
		if (whois.raw) holders = [...holders, { roles: ["registrant"], ...whoisHolder(whois.raw), source: "holder_whois", foundAt: `WHOIS ${server}` }];
	}
	const own = holders.filter((holder) => !isPrivacyPlaceholder({ ...(holder.name ? { name: holder.name } : {}), ...(holder.organization ? { organization: holder.organization } : {}) }));
	const contacts = own.flatMap((holder) => holder.emails
		.filter((email) => !isPrivacyPlaceholder({ email }, registrarDomains))
		.flatMap((email) => {
			const rank = mailboxRank(email);
			return rank === undefined ? [] : [{ email, source: holder.source, foundAt: holder.foundAt, rank }];
		}));
	const holder = own.find((candidate) => candidate.roles.includes("registrant") && candidate.organization)?.organization;
	return { contacts, ...(holder ? { holder } : {}), redacted: holders.length > 0 && contacts.length === 0 };
}

/** Best first: the mailbox's purpose, then the business's own domain before another's (a linked agency, a payment processor), then where it was found. */
function ranked(contacts: SiteContact[], site: string): SiteContact[] {
	const best = new Map<string, SiteContact>();
	for (const contact of contacts) {
		const existing = best.get(contact.email);
		if (!existing || contact.rank < existing.rank || (contact.rank === existing.rank && SOURCE_ORDER.indexOf(contact.source) < SOURCE_ORDER.indexOf(existing.source))) best.set(contact.email, contact);
	}
	const foreign = (contact: SiteContact) => businessSite(contact.email.slice(contact.email.lastIndexOf("@") + 1)) === site ? 0 : 1;
	return [...best.values()].sort((a, b) => a.rank - b.rank || foreign(a) - foreign(b) || SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
}

/**
 * Finds the mailboxes a business publishes for a complaint about one of its
 * affiliates: its security.txt, its home page and the contact, affiliate,
 * terms and support pages it links (or that commonly exist), and its domain
 * registration when that names the holder. Every request goes through the
 * public-redirect guard (public hosts only, each hop checked) and is bounded
 * in time and size.
 */
export async function searchSiteContacts(site: string, dependencies: ResolverDependencies = {}): Promise<SiteContactSearch> {
	const search: SiteContactSearch = { site, contacts: [], redacted: false, checked: [], failures: [] };
	const [securityTxt, home, registration] = await Promise.all([
		fetchPage(`https://${site}/.well-known/security.txt`, site, dependencies, search),
		fetchPage(`https://${site}/`, site, dependencies, search).then((page) => page ?? fetchPage(`https://www.${site}/`, site, dependencies, search)),
		registrationContacts(site, dependencies, search),
	]);
	const found: SiteContact[] = [...registration.contacts];
	// A security.txt answered with an HTML page is a soft 404, not a security.txt.
	if (securityTxt && !/<html|<body/i.test(securityTxt.body)) {
		for (const email of securityTxtEmails(securityTxt.body)) {
			const rank = mailboxRank(email);
			if (rank !== undefined) found.push({ email, source: "security_txt", foundAt: securityTxt.url, rank });
		}
	}
	const origin = home ? new URL(home.url).origin : `https://${site}`;
	const linked = home ? contactPageLinks(home.body, new URL(home.url), site) : [];
	const wellKnown = WELL_KNOWN_PAGES.map((path) => `${origin}${path}`).filter((url) => !linked.includes(url));
	const pages = await Promise.all([...linked, ...wellKnown].slice(0, MAX_LINKED_PAGES).map((url) => fetchPage(url, site, dependencies, search)));
	for (const page of [home, ...pages]) {
		if (!page) continue;
		for (const { email, explicit } of htmlEmails(page.body)) {
			// Text that merely mentions another business's address is not this business's contact.
			if (!explicit && businessSite(email.slice(email.lastIndexOf("@") + 1)) !== site) continue;
			const rank = mailboxRank(email);
			if (rank !== undefined) found.push({ email, source: "website", foundAt: page.url, rank });
		}
	}
	return {
		...search,
		contacts: ranked(found, site),
		...(registration.holder ? { holder: registration.holder } : {}),
		redacted: registration.redacted,
	};
}

/** The platform vendor's contact: the address it publishes, else the best its own site lists. */
async function vendorContact(vendor: PlatformVendor, dependencies: ResolverDependencies): Promise<SiteContact | undefined> {
	if (vendor.email) return { email: vendor.email, source: "platform_vendor", foundAt: vendor.source ?? vendor.domain, rank: 0 };
	const [best] = (await searchSiteContacts(vendor.domain, dependencies)).contacts;
	return best && { ...best, source: "platform_vendor" };
}

/** Snapshot of a funnel party's resolution; the draft reads its `funnelParty`. */
type FunnelResolutionSnapshot = JsonRecord & {
	funnelParty: { role: "merchant" | "network"; site: string; platform?: string; affiliateId?: string };
	platformVendor?: { name: string; domain: string };
};

/**
 * Resolves the recipient of a funnel report without an operator: the
 * business's own best mailbox, the rest of its mailboxes as fallbacks after
 * a bounce, and for a network's tracking domain the platform vendor last
 * (first when the operator publishes none). A business without any contact
 * has no route; one whose lookups failed is resolved again by the worker.
 */
export async function resolveFunnelPartyTarget(target: ResolverTarget, dependencies: ResolverDependencies = {}): Promise<ResolvedAbuseTarget> {
	const party = parseFunnelPartyTarget(target.normalizedTarget);
	if (!party) throw new Error(`${target.normalizedTarget} is not a funnel party.`);
	const search = await searchSiteContacts(party.site, dependencies);
	const vendor = party.role === "network" && party.platform ? FUNNEL_PLATFORM_VENDORS[party.platform] : undefined;
	const fallback = vendor ? await vendorContact(vendor, dependencies) : undefined;
	const snapshot: FunnelResolutionSnapshot = {
		target: target.normalizedTarget,
		targetType: target.targetType,
		funnelParty: party,
		contactSearch: { checked: search.checked, failures: search.failures, redacted: search.redacted, ...(search.holder ? { holder: search.holder } : {}) },
		...(vendor ? { platformVendor: { name: vendor.name, domain: vendor.domain } } : {}),
	};
	const contacts = [...search.contacts, ...(fallback && !search.contacts.some(({ email }) => email === fallback.email) ? [fallback] : [])];
	const [primary, ...rest] = contacts;
	if (!primary) {
		const failed = search.failures.length > 0;
		const reason = failed ? "funnel_contact_lookup_failed" : party.role === "merchant" ? "no_merchant_contact" : "no_network_contact";
		return {
			status: failed ? "failed" : "no_route",
			disposition: reason,
			resolverSnapshot: snapshot,
			routes: [unroutableRoute(reason, snapshot, failed ? "failed" : "no_route")],
			...(failed ? { lookupFailures: search.failures } : {}),
		};
	}
	const organization = (contact: SiteContact) => contact.source === "platform_vendor" ? vendor!.name : search.holder ?? party.site;
	const mailbox = (contact: SiteContact): AbuseMailbox => ({ email: contact.email, source: contact.source, organization: organization(contact), foundAt: contact.foundAt });
	return {
		status: "resolved",
		resolverSnapshot: snapshot,
		routes: [emailRoute({
			email: primary.email,
			providerName: organization(primary),
			provenance: contactChainProvenance([mailbox(primary), ...rest.map(mailbox)]),
			snapshot,
		})],
	};
}
