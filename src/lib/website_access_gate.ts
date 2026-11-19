import { SubmissionsEntity } from "./db/entities/submissions";
import { errorSummary } from "./error_text";
import { fetchThroughPublicRedirects } from "./network/public_redirects";
import { isSameWebsite, websiteSite } from "./website_site";
import { isFlowStepHop, type WebsiteNavigationHop } from "./website_types";

/**
 * How visitors got into a reported site when the site does not show its page
 * to everyone: kits hand out a link to an entry on another site (often behind
 * a CAPTCHA), which issues each visitor a one-time link with a short-lived
 * token; the token sets a session, and any visit without one is sent to a
 * decoy (example.com, a search engine, the brand's real site). A reviewer
 * opening the reported URL directly then sees nothing; the report and every
 * answer to a provider have to say how the page is reached.
 */
export type WebsiteAccessGate = {
	/** The link handed out on another site, where the visit started. */
	entryUrl?: string;
	/** The entry had the visitor pass a page of its own first (a check or a button). */
	entryStep?: boolean;
	/** The one-time link into the reported site the visit arrived with. */
	ticket?: { url: string; issuedAt?: string; expiresAt?: string; lifetimeSeconds?: number };
	/** What a request without the ticket's session got, when the report was filed. */
	bareVisit?: { url: string; reachedUrl: string; checkedAt: string };
};

/**
 * Every hop from the link first submitted to the captured page: a case handed
 * off from a redirecting site (`redirect:<id>`) starts where the earliest case
 * of its chain was submitted.
 */
export async function arrivalChain(submissionId: bigint): Promise<WebsiteNavigationHop[]> {
	const own = await SubmissionsEntity.get(submissionId);
	const hops = own?.data.kind === "website" ? own.data.website.navigationHops ?? [] : [];
	let source = own?.source;
	let root: WebsiteNavigationHop[] | undefined;
	// A chain is a handful of redirecting sites at most; the bound only stops a cycle.
	for (let depth = 0; depth < 8 && source?.startsWith("redirect:"); depth++) {
		const parent = await SubmissionsEntity.get(BigInt(source.slice("redirect:".length)));
		if (parent?.data.kind !== "website") break;
		root = parent.data.website.navigationHops ?? root;
		source = parent.source;
	}
	const first = hops[0];
	if (!root || !first) return hops;
	const joined = root.findIndex((hop) => hop.url === first.url);
	return [...(joined >= 0 ? root.slice(0, joined) : root.filter((hop) => !isSameWebsite(hop.url, first.url))), ...hops];
}

/**
 * The gate in front of the captured page, read from the arrival chain: the
 * hops on other sites before the reported one, and a first URL on it that
 * carries a token. A page reached directly has none.
 */
export function accessGateOf(chain: readonly WebsiteNavigationHop[], capturedUrl: string): WebsiteAccessGate | undefined {
	const arrival = chain.findIndex((hop) => isSameWebsite(hop.url, capturedUrl));
	if (arrival < 0) return undefined;
	const entry = chain.slice(0, arrival);
	const ticket = ticketOf(chain[arrival]!, capturedUrl);
	if (!entry.length && !ticket) return undefined;
	return {
		...(entry.length ? { entryUrl: entry[0]!.url, entryStep: entry.some(isFlowStepHop) } : {}),
		...(ticket ? { ticket } : {}),
	};
}

/**
 * The first URL a visit had on the reported site, as a one-time link: one
 * that carries a JWT, whose claims say how long it is valid. An opaque token
 * is not told from an ordinary query; the bare visit shows its gate instead.
 */
function ticketOf(hop: WebsiteNavigationHop, capturedUrl: string): WebsiteAccessGate["ticket"] {
	const url = new URL(hop.url);
	if (!url.search || hop.url === capturedUrl) return undefined;
	for (const value of url.searchParams.values()) {
		const claims = jwtClaims(value);
		if (!claims) continue;
		const issued = typeof claims.iat === "number" ? claims.iat : undefined;
		const expires = typeof claims.exp === "number" ? claims.exp : undefined;
		return {
			url: hop.url,
			...(issued !== undefined ? { issuedAt: new Date(issued * 1_000).toISOString() } : {}),
			...(expires !== undefined ? { expiresAt: new Date(expires * 1_000).toISOString() } : {}),
			...(issued !== undefined && expires !== undefined && expires > issued ? { lifetimeSeconds: expires - issued } : {}),
		};
	}
	return undefined;
}

function jwtClaims(value: string): Record<string, unknown> | undefined {
	const parts = value.split(".");
	if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]*$/.test(part)) || !parts[1]) return undefined;
	try {
		const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as unknown;
		const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
		if (!header || typeof header !== "object" || !claims || typeof claims !== "object" || Array.isArray(claims)) return undefined;
		return claims as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

export type BareVisitDependencies = {
	fetch?: typeof fetch;
	assertPublicHost?: (hostname: string) => Promise<void>;
	now?: () => Date;
};

/**
 * Request the captured page once without the session the ticket set, with the
 * browser the case presented, following redirects; undefined when it does not
 * answer. A page that answers with a decoy is sent elsewhere by plain
 * redirects, which this sees; a decoy picked by script is left to rechecks in
 * a browser.
 */
export async function checkBareVisit(url: string, userAgent: string | undefined, dependencies: BareVisitDependencies = {}): Promise<WebsiteAccessGate["bareVisit"]> {
	const checkedAt = (dependencies.now ?? (() => new Date()))().toISOString();
	try {
		const { response, urls } = await fetchThroughPublicRedirects(url, {
			subject: "reported page",
			maxRedirects: 10,
			timeoutMs: 20_000,
			headers: { accept: "text/html,application/xhtml+xml", ...(userAgent ? { "user-agent": userAgent } : {}) },
			...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
			...(dependencies.assertPublicHost ? { assertPublicHost: dependencies.assertPublicHost } : {}),
		});
		await response.body?.cancel().catch(() => undefined);
		return { url, reachedUrl: urls.at(-1)!, checkedAt };
	} catch (error) {
		console.warn(`Bare visit of ${url} got no answer: ${errorSummary(error)}`);
		return undefined;
	}
}

/** Whether a request without the session left the reported site: its decoy. */
export function bareVisitLeftSite(gate: WebsiteAccessGate): boolean {
	return Boolean(gate.bareVisit && !isSameWebsite(gate.bareVisit.reachedUrl, gate.bareVisit.url));
}

const shown = (url: string) => (url.length > 160 ? `${url.slice(0, 157)}...` : url);

function lifetime(seconds: number): string {
	return seconds < 120 ? `${seconds} seconds` : seconds < 7_200 ? `${Math.round(seconds / 60)} minutes` : `${Math.round(seconds / 3_600)} hours`;
}

/**
 * The gate in the report's words: where victims enter, the one-time link and
 * its validity, what a visit without it gets, and how to see the page. Empty
 * when the page is open to anyone who opens it.
 */
export function accessGateStatements(gate: WebsiteAccessGate | undefined, capturedUrl: string, caseUrl?: string): string[] {
	if (!gate) return [];
	const site = websiteSite(capturedUrl);
	const decoy = bareVisitLeftSite(gate) ? gate.bareVisit : undefined;
	const statements: string[] = [];
	if (gate.entryUrl) {
		statements.push(`Victims are sent to ${gate.entryUrl}, a link on another site, which ${gate.entryStep ? "first has them pass a check page of its own and then " : ""}forwards each of them to ${site}.`);
	}
	if (gate.ticket) {
		const validity = gate.ticket.lifetimeSeconds !== undefined ? ` whose token is valid for only ${lifetime(gate.ticket.lifetimeSeconds)}` : "";
		statements.push(`Each visitor arrives with a one-time link${validity} (ours: ${shown(gate.ticket.url)}); it sets a session and moves on to ${capturedUrl}, which shows the page only with that session.`);
	}
	if (decoy) {
		statements.push(`Opened ${gate.ticket ? "without that session" : "directly"}, ${decoy.url} sends visitors to ${shown(decoy.reachedUrl)} (checked ${decoy.checkedAt}): that is the kit hiding from reviewers and scanners, not the page being gone.`);
	}
	if (decoy || gate.ticket) {
		const how = gate.entryUrl ? `follow ${gate.entryUrl} in a browser and continue straight through` : "follow the link a victim received";
		statements.push(`To see the page, ${how}${caseUrl ? `; our capture of what victims see, with screenshots, is at ${caseUrl}` : ""}.`);
	}
	return statements;
}
