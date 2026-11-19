import type { SiteCheckState } from "./schema";

/** The page a visit ended on. */
export type SitePage = {
	status: number;
	/** Where the visit ended, after HTTP redirects. */
	url: string;
	/** Response headers, names in lower case. */
	headers: Readonly<Record<string, string>>;
	/** The body as text, when it was text and within the read bound. */
	body?: string;
};

/**
 * A page that infrastructure puts in place of a site: a takedown, a
 * suspension, a parking or for-sale page. Every condition it sets must hold.
 */
export type PageSignature = {
	name: string;
	state: SiteCheckState;
	url?: RegExp;
	/** Header patterns by lower-case header name. */
	headers?: Readonly<Record<string, RegExp>>;
	/** Patterns that must all occur in the body. */
	body?: readonly RegExp[];
};

/** "This domain has been suspended", "the website is disabled", … */
const SUSPENDED = /\b(?:domain|website|site)\b[^<.]{0,60}\b(?:has been|is|was)\s+(?:suspended|deactivated|disabled)/i;

/**
 * The pages that replace a reported site, the first that matches wins. They
 * come from the platforms' own pages (captured live where a missing site
 * shows them) and from public reports of their takedown and parking pages.
 * The interstitial and bot checks come first: they sit in front of whatever
 * the origin serves.
 */
export const PAGE_SIGNATURES: readonly PageSignature[] = [
	// The CDN's own pages in front of the site.
	{
		name: "Cloudflare phishing interstitial",
		state: "cdn_blocked",
		headers: { "cf-ray": /./ },
		body: [/Suspected Phishing/i, /phish-bypass|flagged as phishing|reported for potential phishing/i],
	},
	// A bot check says nothing about the site behind it; the site is still served to people.
	{ name: "Cloudflare bot challenge", state: "online", headers: { "cf-mitigated": /challenge/i } },
	{
		name: "Cloudflare bot challenge",
		state: "online",
		headers: { "cf-ray": /./ },
		body: [/<title>\s*Just a moment\.\.\.\s*<\/title>/i, /challenges\.cloudflare\.com|_cf_chl_opt/i],
	},

	// Registrars and registries.
	{ name: "Namecheap domain suspension page", state: "domain_suspended", body: [/namecheap|registrar-servers\.com/i, SUSPENDED] },
	{ name: "NameSilo domain suspension page", state: "domain_suspended", body: [/namesilo/i, SUSPENDED] },
	{ name: "Gname domain suspension page", state: "domain_suspended", body: [/gname/i, SUSPENDED] },
	{
		name: "ICANN contact verification suspension page",
		state: "domain_suspended",
		body: [/suspended[^<]{0,120}(?:ICANN|contact verification|verif(?:y|ication) (?:of )?(?:the )?(?:registrant|contact|e-?mail))/i],
	},
	{ name: "Registrar domain suspension page", state: "domain_suspended", body: [/\b(?:This|The) domain(?: name)?(?: [a-z0-9.-]+\.[a-z]{2,})? (?:has been|is|was) (?:suspended|deactivated|disabled|blocked)/i] },

	// Parking and for-sale pages.
	{ name: "GoDaddy parking page", state: "parked", body: [/window\.location\.href\s*=\s*["']\/lander["']|wsimg\.com\/parking-lander|This Web page is parked/i] },
	{ name: "Sedo parking page", state: "parked", body: [/sedoparking\.com|may be for sale by its owner/i] },
	{ name: "Sedo for-sale page", state: "parked", url: /^https?:\/\/(?:www\.)?sedo\.com\//i },
	{ name: "Bodis parking page", state: "parked", body: [/parking\.bodis\.com|window\.park\s*=\s*["']/i] },
	{ name: "ParkingCrew parking page", state: "parked", body: [/parkingcrew\.net/i] },
	{ name: "Afternic for-sale page", state: "parked", url: /^https?:\/\/(?:www\.)?afternic\.com\//i },
	{ name: "Afternic for-sale page", state: "parked", body: [/afternic\.com\/(?:forsale|domain)/i] },
	{ name: "Dan.com for-sale page", state: "parked", url: /^https?:\/\/(?:www\.)?dan\.com\//i },
	{ name: "Dan.com for-sale page", state: "parked", body: [/dan\.com\/buy-domain/i] },
	{ name: "HugeDomains for-sale page", state: "parked", url: /^https?:\/\/(?:www\.)?hugedomains\.com\//i },
	{ name: "HugeDomains for-sale page", state: "parked", body: [/hugedomains\.com\/domain_profile/i] },
	{ name: "Namecheap parking page", state: "parked", body: [/parkingpage\.namecheap\.com|(?:is|was) registered at Namecheap|Namecheap(?:\.com)? parked/i] },
	{ name: "Hostinger parking page", state: "parked", body: [/Parked Domain name on Hostinger DNS system/i] },
	{ name: "Dynadot parking page", state: "parked", body: [/parked (?:free(?: of charge)? )?(?:with|at|by) Dynadot/i] },
	{ name: "Domain for sale page", state: "parked", body: [/\b(?:This|The) domain(?: name)?(?: [a-z0-9.-]+\.[a-z]{2,})? (?:is|may be) for sale|\bBuy this domain\b/i] },
	{ name: "Expired domain page", state: "parked", body: [/\b(?:This|The) domain(?: name)?(?: [a-z0-9.-]+\.[a-z]{2,})? (?:has expired|is expired|expired on)/i] },

	// Hosting providers and platforms suspending the site.
	{ name: "cPanel account suspension page", state: "host_suspended", body: [/This Account has been suspended/i, /Contact your hosting provider/i] },
	{ name: "cPanel account suspension page", state: "host_suspended", url: /\/cgi-sys\/suspendedpage\.cgi\b/i, body: [/suspended/i] },
	{ name: "Render service suspension", state: "host_suspended", headers: { "x-render-routing": /^suspend/i } },
	{ name: "Render service suspension", state: "host_suspended", body: [/This service has been suspended/i] },
	{ name: "Vercel disabled deployment", state: "host_suspended", headers: { "x-vercel-error": /^DEPLOYMENT_(?:DISABLED|BLOCKED|PAUSED)$/i } },
	{ name: "Vercel disabled deployment", state: "host_suspended", body: [/This deployment has been disabled|\bDEPLOYMENT_(?:DISABLED|BLOCKED)\b/i] },
	{ name: "Netlify site suspension", state: "host_suspended", body: [/netlify/i, /\b(?:site|account) (?:has been|was) suspended|Site not available/i] },
	{ name: "Hostinger website suspension", state: "host_suspended", body: [/hostinger/i, /<title>[^<]*suspended/i] },
	{ name: "Firebase Hosting site not found", state: "host_suspended", body: [/<title>\s*Site Not Found\s*<\/title>/i, /You haven(?:'|&#39;|&#x27;|’)t deployed an app yet/i] },
	{ name: "Wix site disconnected", state: "host_suspended", body: [/Isn(?:'|&#39;|&#x27;|’)t Connected To A Website Yet/i] },
	{ name: "Weebly site suspension", state: "host_suspended", body: [/weebly/i, SUSPENDED] },
	{ name: "Shopify store unavailable", state: "host_suspended", body: [/Sorry, this (?:shop|store) is currently unavailable/i] },
	{ name: "Terms-of-service takedown notice", state: "host_suspended", body: [/(?:taken down|has been removed|has been disabled|has been suspended)[^<]{0,120}(?:violat|terms of service|program policies|acceptable use)/i] },
	{ name: "Hosting suspension page", state: "host_suspended", body: [/\b(?:This|The) (?:website|site|web site|hosting account) (?:has been|is|was) (?:suspended|disabled|deactivated)/i] },

	// Platforms answering for a site that no longer exists.
	{ name: "GitHub Pages: no site here", state: "removed", body: [/There isn(?:'|&#39;|&#x27;|’)t a GitHub Pages site here/i] },
	{ name: "Vercel deployment not found", state: "removed", headers: { "x-vercel-error": /^(?:DEPLOYMENT_)?NOT_FOUND$/i } },
	{ name: "Netlify site not found", state: "removed", headers: { server: /netlify/i }, body: [/Not Found - Request ID/i] },
	{ name: "Render service not found", state: "removed", headers: { "x-render-routing": /^no-(?:server|deploy)/i } },
	{ name: "Heroku app not found", state: "removed", body: [/<title>\s*No such app\s*<\/title>|herokucdn\.com\/error-pages\/no-such-app/i] },
	{ name: "Surge project not found", state: "removed", headers: { server: /surge/i }, body: [/project not found/i] },
	{ name: "Framer site not found", state: "removed", body: [/Site Not Found \| Framer/i] },
	{ name: "Replit app not live", state: "removed", body: [/This app isn(?:'|&#39;|&#x27;|’)t live yet/i] },
	{ name: "Glitch project hosting ended", state: "removed", body: [/Glitch project hosting is no longer available/i] },
	{ name: "Storage bucket deleted", state: "removed", body: [/<Code>NoSuchBucket<\/Code>/] },
];

/**
 * A takedown or parking page never asks for a password or a card number;
 * a page that does is the kit, whatever text it borrows (renewal and
 * "account suspended" lures quote exactly these pages).
 */
const CREDENTIAL_FIELD = /<input\b[^>]*\b(?:type\s*=\s*["']?password\b|autocomplete\s*=\s*["']?cc-|name\s*=\s*["']?[\w-]*(?:card[-_]?num|cc[-_]?num|cvv|cvc))/i;

function matches(signature: PageSignature, page: SitePage): boolean {
	if (signature.url && !signature.url.test(page.url)) return false;
	for (const [name, pattern] of Object.entries(signature.headers ?? {})) {
		const value = page.headers[name];
		if (value === undefined || !pattern.test(value)) return false;
	}
	if (signature.body && !(page.body !== undefined && signature.body.every((pattern) => pattern.test(page.body!)))) return false;
	return true;
}

/** The first signature the page matches; none for a page with a credential field. */
export function matchPageSignature(page: SitePage, signatures: readonly PageSignature[] = PAGE_SIGNATURES): PageSignature | undefined {
	if (page.body !== undefined && CREDENTIAL_FIELD.test(page.body)) return undefined;
	return signatures.find((signature) => matches(signature, page));
}
