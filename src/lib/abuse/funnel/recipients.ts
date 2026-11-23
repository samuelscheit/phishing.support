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
import { businessSite, isPlatformTenant } from "./chain";
import { contactPageLinks, htmlEmails, isPrivacyPlaceholder, mailboxRank, securityTxtEmails, whoisHolder, type ContactSource, type SiteContact } from "./contacts";
import { parseFunnelPartyTarget } from "./target";
import { FUNNEL_PLATFORM_VENDORS, type PlatformVendor } from "./vendors";

const PAGE_TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
/** The home page and security.txt, plus at most this many linked or well-known pages. */
const MAX_LINKED_PAGES = 6;
const WELL_KNOWN_PAGES = ["/contact", "/contact-us", "/affiliates", "/terms"];
const SOURCE_ORDER: readonly ContactSource[] = ["funnel_security_txt", "funnel_website", "funnel_holder_rdap", "funnel_holder_whois", "funnel_platform_vendor"];

/** What the search for a business's contacts found, and what it consulted. */
export type SiteContactSearch = {
	site: string;
	/** Suitable mailboxes, best first: the business's own domain strictly before the holder's mailbox at another domain. */
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
		.map((holder) => ({ ...holder, source: "funnel_holder_rdap", foundAt: registrar.url ?? `RDAP domain ${site}` }));
	if (!holders.some(({ emails }) => emails.length)) {
		const server = extractPort43(registrar.record) ?? extractPort43(record);
		if (server) search.checked.push(`WHOIS ${server}`);
		const whois = await queryPort43(server, site, dependencies);
		if (whois.error) search.failures.push(`WHOIS ${server}: ${whois.error}`);
		if (whois.raw) holders = [...holders, { roles: ["registrant"], ...whoisHolder(whois.raw), source: "funnel_holder_whois", foundAt: `WHOIS ${server}` }];
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

function isOwnMailbox(email: string, site: string): boolean {
	return businessSite(email.slice(email.lastIndexOf("@") + 1)) === site;
}

/**
 * Best first: the business's own domain strictly before any other (only the
 * domain holder's registered mailbox may be at another domain), then the
 * mailbox's purpose, then where it was found.
 */
function ranked(contacts: SiteContact[], site: string): SiteContact[] {
	const best = new Map<string, SiteContact>();
	for (const contact of contacts) {
		const existing = best.get(contact.email);
		if (!existing || contact.rank < existing.rank || (contact.rank === existing.rank && SOURCE_ORDER.indexOf(contact.source) < SOURCE_ORDER.indexOf(existing.source))) best.set(contact.email, contact);
	}
	const foreign = (contact: SiteContact) => isOwnMailbox(contact.email, site) ? 0 : 1;
	return [...best.values()].sort((a, b) => foreign(a) - foreign(b) || a.rank - b.rank || SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
}

/**
 * Finds the mailboxes a business publishes for a complaint about one of its
 * affiliates: its security.txt, its home page and the contact, affiliate,
 * terms and support pages it links (or that commonly exist), and its domain
 * registration when that names the holder. A page or security.txt counts
 * only with mailboxes at the business's own domain: a terms page also links
 * the FTC, an agency, a payment processor. A platform tenant
 * (`store1.myshopify.com`) has no registration or security.txt of its own;
 * those are the platform's. Every request goes through the public-redirect
 * guard (public hosts only, each hop checked) and is bounded in time and size.
 */
export async function searchSiteContacts(site: string, dependencies: ResolverDependencies = {}): Promise<SiteContactSearch> {
	const search: SiteContactSearch = { site, contacts: [], redacted: false, checked: [], failures: [] };
	const tenant = isPlatformTenant(site);
	const [securityTxt, home, registration] = await Promise.all([
		tenant ? undefined : fetchPage(`https://${site}/.well-known/security.txt`, site, dependencies, search),
		fetchPage(`https://${site}/`, site, dependencies, search).then((page) => page ?? (tenant ? undefined : fetchPage(`https://www.${site}/`, site, dependencies, search))),
		tenant ? { contacts: [], redacted: false } satisfies Registration as Registration : registrationContacts(site, dependencies, search),
	]);
	const found: SiteContact[] = [...registration.contacts];
	const add = (email: string, source: ContactSource, foundAt: string) => {
		const rank = mailboxRank(email);
		if (rank !== undefined && isOwnMailbox(email, site)) found.push({ email, source, foundAt, rank });
	};
	// A security.txt answered with an HTML page is a soft 404, not a security.txt.
	if (securityTxt && !/<html|<body/i.test(securityTxt.body)) {
		for (const email of securityTxtEmails(securityTxt.body)) add(email, "funnel_security_txt", securityTxt.url);
	}
	const origin = home ? new URL(home.url).origin : `https://${site}`;
	const linked = home ? contactPageLinks(home.body, new URL(home.url), site) : [];
	const wellKnown = WELL_KNOWN_PAGES.map((path) => `${origin}${path}`).filter((url) => !linked.includes(url));
	const pages = await Promise.all([...linked, ...wellKnown].slice(0, MAX_LINKED_PAGES).map((url) => fetchPage(url, site, dependencies, search)));
	for (const page of [home, ...pages]) {
		if (page) for (const email of htmlEmails(page.body)) add(email, "funnel_website", page.url);
	}
	return {
		...search,
		contacts: ranked(found, site),
		...(registration.holder ? { holder: registration.holder } : {}),
		redacted: registration.redacted,
	};
}

function vendorContact(vendor: PlatformVendor): SiteContact {
	return { email: vendor.email, source: "funnel_platform_vendor", foundAt: vendor.source, rank: 0 };
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
 * (first when the operator publishes none). The target names a platform only
 * when its link format left no doubt (funnel/report.ts), so a vendor is never
 * asked about a guess. A business without any contact has no route. One
 * whose lookups failed is `failed` with its `lookupFailures`: the worker
 * resolves it again up to RESOLUTION_LOOKUP_RETRIES times, then keeps it
 * failed, with no route and no mail.
 */
export async function resolveFunnelPartyTarget(target: ResolverTarget, dependencies: ResolverDependencies = {}): Promise<ResolvedAbuseTarget> {
	const party = parseFunnelPartyTarget(target.normalizedTarget);
	if (!party) throw new Error(`${target.normalizedTarget} is not a funnel party.`);
	const search = await searchSiteContacts(party.site, dependencies);
	const vendor = party.role === "network" && party.platform ? FUNNEL_PLATFORM_VENDORS[party.platform] : undefined;
	const fallback = vendor ? vendorContact(vendor) : undefined;
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
	const organization = (contact: SiteContact) => contact.source === "funnel_platform_vendor" ? vendor!.name : search.holder ?? party.site;
	const mailbox = (contact: SiteContact): AbuseMailbox => ({ email: contact.email, source: contact.source, organization: organization(contact), foundAt: contact.foundAt });
	// A stand-in (the vendor, or the holder's mailbox at another domain) is only
	// chosen once the business's own pages could be searched: while a lookup
	// fails, the worker resolves again (up to RESOLUTION_LOOKUP_RETRIES) before
	// it keeps this route, and the mail then says the site did not answer.
	const standIn = primary.source === "funnel_platform_vendor" || !isOwnMailbox(primary.email, party.site);
	return {
		status: "resolved",
		resolverSnapshot: snapshot,
		routes: [emailRoute({
			email: primary.email,
			providerName: organization(primary),
			provenance: contactChainProvenance([mailbox(primary), ...rest.map(mailbox)]),
			snapshot,
		})],
		...(standIn && search.failures.length ? { lookupFailures: search.failures } : {}),
	};
}
