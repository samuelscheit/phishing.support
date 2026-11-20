import { describe, expect, test } from "bun:test";

import { SubmissionsEntity } from "../db/entities/submissions";
import { useTemporaryDatabase } from "../db/test_helpers";
import { accessGateOf, accessGateStatements, arrivalChain, bareVisitLeftSite, checkBareVisit } from "./access_gate";
import { buildWebsiteReportEvidence } from "./classification";
import type { WebsiteNavigationHop } from "./types";

useTemporaryDatabase();

// Production case 381727464776274088: the link handed out is a workers.dev entry behind
// Cloudflare Turnstile; it issues a JWT valid for 120 seconds, which sets lbbvw.com's
// session; lbbvw.com/ without it goes to href.li and on to example.com.
const ENTRY = "https://f24ac216.37b963ba383fc01de7edcef8.workers.dev/";
const TICKET = "https://lbbvw.com/?dataXX0=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1cmwiOiJodHRwczovL2xiYnZ3LmNvbS8iLCJkb21haW4iOiJsYmJ2dy5jb20iLCJrZXkiOiJTUlZ3UWJuZjAzb2QiLCJxcmMiOm51bGwsImlhdCI6MTc5NTA3ODA2MCwiZXhwIjoxNzk1MDc4MTgwfQ.qAQe7AM6yZdPpNWwd5ao1NTlafcHGAFeYM_Ue6L02qA";
const PAGE = "https://lbbvw.com/";
const hop = (index: number, url: string, status: number, extra: Partial<WebsiteNavigationHop> = {}): WebsiteNavigationHop => ({ index, url, hostname: new URL(url).hostname, status, contentCaptured: false, ...extra });
const ROOT_HOPS = [
	hop(0, ENTRY, 200, { redirectTo: ENTRY, visitorStep: { submitted: [] } }),
	hop(1, ENTRY, 302, { redirectTo: TICKET }),
	hop(2, TICKET, 302, { redirectTo: PAGE }),
	hop(3, PAGE, 200, { contentCaptured: true }),
];
const CASE_HOPS = [hop(0, TICKET, 302, { redirectTo: PAGE }), hop(1, PAGE, 200, { contentCaptured: true })];

async function redirectedCase(rootId: bigint, caseId: bigint, caseHops = CASE_HOPS) {
	await SubmissionsEntity.create({ id: rootId, kind: "website", dedupeKey: `root-${rootId}`, status: "redirected", data: { kind: "website", website: { url: ENTRY, navigationHops: ROOT_HOPS, redirectSubmissionId: caseId.toString() } } });
	await SubmissionsEntity.create({ id: caseId, kind: "website", source: `redirect:${rootId}`, dedupeKey: `case-${caseId}`, status: "reported", data: { kind: "website", website: { url: TICKET, archiveUrl: PAGE, navigationHops: caseHops } } });
}

/** lbbvw.com as observed: without a session, two redirects to href.li, which shows its own page. */
const decoyingSite = (async (input: URL | RequestInfo) => {
	const url = new URL(String(input instanceof Request ? input.url : input));
	if (url.href === PAGE) return new Response(null, { status: 302, headers: { location: "/?bkwujcdn" } });
	if (url.href === "https://lbbvw.com/?bkwujcdn") return new Response(null, { status: 302, headers: { location: "https://href.li/?https://example.com" } });
	return new Response("<html>redirecting</html>", { status: 200, headers: { "content-type": "text/html" } });
}) as typeof fetch;

describe("access gate of a reported page", () => {
	test("a case handed off from an entry gets the entry's hops before its own; a direct case keeps its own", async () => {
		await redirectedCase(1n, 2n);
		expect((await arrivalChain(2n)).map(({ url }) => url)).toEqual([ENTRY, ENTRY, TICKET, PAGE]);
		// The case's own visit went further than the entry's capture: its hops are kept.
		await redirectedCase(3n, 4n, [...CASE_HOPS.slice(0, 1), hop(1, PAGE, 200, { visitorStep: { submitted: [] } }), hop(2, "https://lbbvw.com/verify", 200, { contentCaptured: true })]);
		expect((await arrivalChain(4n)).map(({ url }) => url)).toEqual([ENTRY, ENTRY, TICKET, PAGE, "https://lbbvw.com/verify"]);
		await SubmissionsEntity.create({ id: 5n, kind: "website", dedupeKey: "direct", data: { kind: "website", website: { url: PAGE, navigationHops: CASE_HOPS } } });
		expect((await arrivalChain(5n)).map(({ url }) => url)).toEqual([TICKET, PAGE]);
	});

	test("reads the entry, its own page and the ticket's lifetime from the token's claims", () => {
		expect(accessGateOf(ROOT_HOPS, PAGE)).toEqual({
			entryUrl: ENTRY,
			entryStep: true,
			ticket: { url: TICKET, issuedAt: "2026-11-19T08:47:40.000Z", expiresAt: "2026-11-19T08:49:40.000Z", lifetimeSeconds: 120 },
		});
		// Without the entry the ticket alone is the gate.
		expect(accessGateOf(CASE_HOPS, PAGE)).toEqual({ ticket: expect.objectContaining({ lifetimeSeconds: 120 }) });
	});

	test("an open page has no gate: a direct visit, an ordinary query, a token-looking value that is no JWT", () => {
		expect(accessGateOf([hop(0, PAGE, 200, { contentCaptured: true })], PAGE)).toBeUndefined();
		expect(accessGateOf([hop(0, "https://kit.example/?utm_source=mail&id=42", 302, { redirectTo: "https://kit.example/login" }), hop(1, "https://kit.example/login", 200, { contentCaptured: true })], "https://kit.example/login")).toBeUndefined();
		expect(accessGateOf([hop(0, "https://kit.example/?t=abc.def.ghi", 302, { redirectTo: "https://kit.example/login" }), hop(1, "https://kit.example/login", 200, { contentCaptured: true })], "https://kit.example/login")).toBeUndefined();
		// The captured page is the token URL itself: nothing moved on from it.
		expect(accessGateOf([hop(0, TICKET, 200, { contentCaptured: true })], TICKET)).toBeUndefined();
	});

	test("a request without the session follows the site's redirects to its decoy; no answer is no check", async () => {
		const now = () => new Date("2026-11-19T08:51:00Z");
		const bareVisit = await checkBareVisit(PAGE, "Mozilla/5.0 Chrome/157", { fetch: decoyingSite, assertPublicHost: async () => {}, now });
		expect(bareVisit).toEqual({ url: PAGE, reachedUrl: "https://href.li/?https://example.com", checkedAt: "2026-11-19T08:51:00.000Z" });
		expect(bareVisitLeftSite({ bareVisit: bareVisit! })).toBe(true);
		const open = async () => new Response("<html>login</html>", { status: 200 });
		expect(bareVisitLeftSite({ bareVisit: (await checkBareVisit(PAGE, undefined, { fetch: open as unknown as typeof fetch, assertPublicHost: async () => {}, now }))! })).toBe(false);
		const down = async () => { throw new TypeError("fetch failed"); };
		expect(await checkBareVisit(PAGE, undefined, { fetch: down as unknown as typeof fetch, assertPublicHost: async () => {}, now })).toBeUndefined();
	});

	test("the report says how victims reach the page, what a direct visit gets, and how to see it, before anything a provider may cut", () => {
		const gate = { ...accessGateOf(ROOT_HOPS, PAGE)!, bareVisit: { url: PAGE, reachedUrl: "https://href.li/?https://example.com", checkedAt: "2026-11-19T08:51:00.000Z" } };
		const statements = accessGateStatements(gate, PAGE, "https://phishing.support/submissions/2");
		expect(statements).toEqual([
			`Victims are sent to ${ENTRY}, a link on another site, which first has them pass a check page of its own and then forwards each of them to lbbvw.com.`,
			`Each visitor arrives with a one-time link whose token is valid for only 2 minutes (ours: ${TICKET.slice(0, 157)}...); it sets a session and moves on to ${PAGE}, which shows the page only with that session.`,
			`Opened without that session, ${PAGE} sends visitors to https://href.li/?https://example.com (checked 2026-11-19T08:51:00.000Z): that is the kit hiding from reviewers and scanners, not the page being gone.`,
			`To see the page, follow ${ENTRY} in a browser and continue straight through; our capture of what victims see, with screenshots, is at https://phishing.support/submissions/2.`,
		]);
		const evidence = buildWebsiteReportEvidence(
			{ finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "3. Sign in with your Microsoft account", impersonatedBrand: { name: "Microsoft OneDrive", officialUrl: "https://www.microsoft.com/" } } as never,
			{ navigationHops: CASE_HOPS, reporterUserAgent: "Mozilla/5.0 Chrome/157", accessGate: gate, caseUrl: "https://phishing.support/submissions/2" },
		);
		expect(evidence.indexOf("Victims are sent to")).toBeGreaterThan(evidence.indexOf("official website"));
		expect(evidence.indexOf("Victims are sent to")).toBeLessThan(evidence.indexOf("User-Agent"));
		for (const statement of statements) expect(evidence).toContain(statement);

		// An entry that only forwards (a link shortener) to a page open to anyone: one plain sentence.
		expect(accessGateStatements({ entryUrl: "https://bit.ly/x", entryStep: false, bareVisit: { url: PAGE, reachedUrl: PAGE, checkedAt: "2026-11-19T08:51:00.000Z" } }, PAGE)).toEqual([
			"Victims are sent to https://bit.ly/x, a link on another site, which forwards each of them to lbbvw.com.",
		]);
		// A site that turns direct visits away with no entry or token we saw.
		expect(accessGateStatements({ bareVisit: gate.bareVisit }, PAGE)).toEqual([
			`Opened directly, ${PAGE} sends visitors to https://href.li/?https://example.com (checked 2026-11-19T08:51:00.000Z): that is the kit hiding from reviewers and scanners, not the page being gone.`,
			"To see the page, follow the link a victim received.",
		]);
		expect(accessGateStatements(undefined, PAGE)).toEqual([]);
	});
});
