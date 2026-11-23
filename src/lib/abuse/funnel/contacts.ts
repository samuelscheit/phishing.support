import { unescapeHtml } from "../../util/html";
import { normalizeMailbox } from "../resolver/records";
import type { FunnelContactSource } from "../resolver/types";
import { businessSite, parsedUrl } from "./chain";
import { percentDecoded } from "./wrappers";

export type ContactSource = FunnelContactSource;

export type SiteContact = {
	email: string;
	source: ContactSource;
	/** The page or record that publishes it. */
	foundAt: string;
	/** 0 is the mailbox meant for this report; see `mailboxRank`. */
	rank: number;
};

/** Mailboxes for affiliate compliance first, then abuse/legal, then the general support desk. */
const MAILBOX_RANKS: ReadonlyArray<readonly [RegExp, number]> = [
	[/^(?:(?:affiliate|partner)s?[._-]?)?compliance$|^(?:affiliate[._-]?)?fraud$/, 0],
	[/^(?:affiliates?|partners?|publishers?|affiliate[._-]?(?:program|programme|team|support|manager|management|desk))$/, 1],
	[/^(?:abuse|legal|security|trust[._-]?(?:and[._-]?)?safety|risk)$/, 2],
	[/^(?:support|help|helpdesk|care|service|contact|contactus|info|hello|team|office|admin|enquiries|inquiries|customer[._-]?(?:service|care|support|success))$/, 3],
];
/** Mailboxes that do not act on a complaint, or never read one. */
const UNSUITABLE_MAILBOX = /^(?:no[._-]?reply|do[._-]?not[._-]?reply|donotreply|privacy|dpo|gdpr|data[._-]?protection|careers?|jobs?|hr|recruit(?:ing|ment)?|press|media|pr|sales|marketing|billing|accounting|invoices?|unsubscribe|newsletter|bounces?|mailer[._-]?daemon|postmaster|hostmaster|webmaster)$/;
/** Placeholders and build artefacts that only look like mailboxes (`logo@2x.png`, a Sentry DSN). */
const NOT_A_MAILBOX_DOMAIN = /\.(?:png|jpe?g|gif|webp|svg|ico|css|js|woff2?|ttf)$|(?:^|\.)(?:sentry\.io|sentry-next\.wixpress\.com|example\.(?:com|org|net)|domain\.com|email\.com|yourdomain\.com|yoursite\.com|company\.com)$/;

/**
 * How well a mailbox suits an affiliate complaint (lower is better), or
 * undefined for one that does not suit it at all. A `+tag` is ignored.
 */
export function mailboxRank(email: string): number | undefined {
	const at = email.lastIndexOf("@");
	const local = email.slice(0, at).replace(/\+.*$/, "").toLowerCase();
	const domain = email.slice(at + 1).toLowerCase();
	if (NOT_A_MAILBOX_DOMAIN.test(domain) || /^[0-9a-f]{16,}$/.test(local) || UNSUITABLE_MAILBOX.test(local)) return undefined;
	return MAILBOX_RANKS.find(([pattern]) => pattern.test(local))?.[1] ?? 4;
}

/** A privacy or proxy service's placeholder, or a mailbox a registry withholds. */
const PRIVACY_PLACEHOLDER = /privacy|proxy|redact|withheld|whoisguard|protect|anonymi[sz]|masked|gdpr|not[\s._-]?disclosed|data[\s._-]?protected|identity[\s._-]?shield|private[\s._-]?(?:registration|person)|contact[\s._-]?form|rdds/i;

/**
 * Whether a registration contact hides the holder: a privacy service's
 * mailbox or name, or a forwarding mailbox at the registrar itself.
 */
export function isPrivacyPlaceholder(contact: { email?: string; name?: string; organization?: string }, registrarDomains: readonly string[] = []): boolean {
	if ([contact.email, contact.name, contact.organization].some((value) => value !== undefined && PRIVACY_PLACEHOLDER.test(value))) return true;
	const domain = contact.email ? businessSite(contact.email.slice(contact.email.lastIndexOf("@") + 1)) : undefined;
	return domain !== undefined && registrarDomains.includes(domain);
}

/** The mailboxes a security.txt (RFC 9116) names in its `Contact:` fields. */
export function securityTxtEmails(text: string): string[] {
	const emails: string[] = [];
	for (const match of text.matchAll(/^[ \t]*Contact[ \t]*:[ \t]*(\S+)/gim)) {
		const value = match[1]!.replace(/^mailto:/i, "").replace(/\?.*$/, "");
		const email = normalizeMailbox(percentDecoded(value) ?? value);
		if (email && !emails.includes(email)) emails.push(email);
	}
	return emails;
}

/** Cloudflare's email obfuscation: the first byte is the XOR key of the rest. */
function cloudflareEmail(hex: string): string | undefined {
	if (!/^(?:[0-9a-f]{2}){2,}$/i.test(hex)) return undefined;
	const key = Number.parseInt(hex.slice(0, 2), 16);
	let decoded = "";
	for (let index = 2; index < hex.length; index += 2) decoded += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16) ^ key);
	return decoded;
}

const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi;
/** `name [at] shop [dot] com`, `name(at)shop.com`. */
const OBFUSCATED_EMAIL = /([a-z0-9._%+-]+)\s*[[(]\s*at\s*[\])]\s*((?:[a-z0-9-]+\s*(?:[[(]\s*dot\s*[\])]|\.)\s*)+[a-z]{2,24})\b/gi;

/** Every mailbox a page publishes: `mailto:` links, Cloudflare-protected addresses, `[at]` spellings and addresses in its text. */
export function htmlEmails(html: string): string[] {
	const found = new Set<string>();
	const add = (value: string | undefined) => {
		const email = normalizeMailbox(value);
		if (email) found.add(email);
	};
	const text = unescapeHtml(html);
	for (const match of text.matchAll(/mailto:([^"'?<>\s]+)/gi)) add(percentDecoded(match[1]!) ?? match[1]);
	for (const match of html.matchAll(/data-cfemail=["']([0-9a-f]+)["']|\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi)) add(cloudflareEmail(match[1] ?? match[2]!));
	for (const match of text.matchAll(OBFUSCATED_EMAIL)) add(`${match[1]}@${match[2]!.replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, ".").replace(/\s+/g, "")}`);
	for (const match of text.matchAll(EMAIL_IN_TEXT)) add(match[0]);
	return [...found];
}

/** Link targets of pages that name a business's contacts, most useful first. */
const CONTACT_PAGE_KINDS: readonly RegExp[] = [
	/affiliat|partner|publisher|compliance/i,
	/contact|kontakt|support|help|customer[\s_-]?service/i,
	/terms|legal|imprint|impressum|disclaimer|conditions/i,
	/about|privacy/i,
];

/**
 * The site's own pages, linked from `html`, whose link names a contact,
 * affiliate, legal or support page; subdomains count as the site
 * (`help.zatos.com` for `zatos.com`).
 */
export function contactPageLinks(html: string, base: URL, site: string): string[] {
	const links: Array<{ url: string; kind: number; order: number }> = [];
	let order = 0;
	for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]{0,400}?)<\/a>/gi)) {
		const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]!);
		const raw = href ? unescapeHtml(href[1] ?? href[2] ?? href[3] ?? "") : "";
		if (!raw || /^(?:mailto|javascript|tel):/i.test(raw)) continue;
		let url: URL | undefined;
		try {
			url = parsedUrl(new URL(raw, base).toString());
		} catch {
			url = undefined;
		}
		if (!url || businessSite(url.hostname) !== site) continue;
		url.hash = "";
		const label = `${url.pathname} ${match[2]!.replace(/<[^>]*>/g, " ")}`;
		const kind = CONTACT_PAGE_KINDS.findIndex((pattern) => pattern.test(label));
		if (kind < 0 || links.some((link) => link.url === url.toString())) continue;
		links.push({ url: url.toString(), kind, order: order++ });
	}
	return links.sort((a, b) => a.kind - b.kind || a.order - b.order).map(({ url }) => url);
}

/**
 * The holder's mailboxes and organization in a port-43 WHOIS answer
 * (`Registrant Email:`, `Admin Email:`). The technical contact is usually
 * the host or a reseller, not the holder, and is left out.
 */
export function whoisHolder(raw: string): { emails: string[]; organization?: string; name?: string } {
	const emails: string[] = [];
	for (const match of raw.matchAll(/^\s*(?:registrant|admin(?:istrative)?)(?:\s+contact)?\s+e-?mail\s*:\s*(\S+)\s*$/gim)) {
		const email = normalizeMailbox(match[1]);
		if (email && !emails.includes(email)) emails.push(email);
	}
	const organization = /^\s*registrant\s+organi[sz]ation\s*:\s*(.+?)\s*$/im.exec(raw)?.[1];
	const name = /^\s*registrant\s+name\s*:\s*(.+?)\s*$/im.exec(raw)?.[1];
	return { emails, ...(organization ? { organization } : {}), ...(name ? { name } : {}) };
}
