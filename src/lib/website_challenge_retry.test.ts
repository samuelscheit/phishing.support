import { describe, expect, test } from "bun:test";

import type { AnalysisClient } from "./analysis_run";
import { FABRIC_EGRESS_LABEL, type FabricEgress } from "./browser/fabric";
import { SubmissionsEntity } from "./db/entities";
import { useTemporaryDatabase } from "./db/test_helpers";
import { scriptedVisitSession } from "./site_visit/test_helpers";
import { websiteSubmissionDedupeKey } from "./submissions/website";
import { analyzeWebsite } from "./website_ai";
import { BrowserInfrastructureError, WebsiteCaptureFailedError, WebsiteUnreachableError, type ArchiveWebsiteOptions, type WebsiteArchiveResult } from "./website_archive";

useTemporaryDatabase();

/**
 * Production case 381535952033550429: a shared note's "AVAA ASIAKIRJA" led to
 * a workers.dev page whose Cloudflare Turnstile never cleared for the Tor
 * exit, and the case ended "no reportable evidence". A visit a challenge
 * blocked is opened again from another network.
 */
const PAGE = "https://f24ac216.37b963ba383fc01de7edcef8.workers.dev/";
const CHALLENGE_TEXT = "Verify you are human\nf24ac216.37b963ba383fc01de7edcef8.workers.dev needs to review the security of your connection before proceeding.";
const SIGN_IN_TEXT = "Microsoft\nSign in to view the shared document\nEmail, phone, or Skype\nNext";
const NOTE_TEXT = "EG-Trading Oy\nSinulla on uusi asiakirja odottamassa tarkastelua\nAVAA ASIAKIRJA";

type Shown = "challenge" | "sign-in" | "note";

/** The page a capture shows; a visit that walks from the note to its challenge page shows that page as its step. */
function captured(options: ArchiveWebsiteOptions, shown: Shown, egress: FabricEgress, walk?: { to: string }): WebsiteArchiveResult {
	const route = FABRIC_EGRESS_LABEL[egress];
	const page = (url: string, pageShown: Shown, report: { blocked: boolean } | undefined): WebsiteArchiveResult => {
		const text = pageShown === "challenge" ? CHALLENGE_TEXT : pageShown === "note" ? NOTE_TEXT : SIGN_IN_TEXT;
		const html = pageShown === "challenge"
			? `<html><body><p>${CHALLENGE_TEXT}</p><div class="cf-turnstile"></div></body></html>`
			: pageShown === "note"
				? `<html><body><p>${NOTE_TEXT}</p><a href="/document" target="_blank">AVAA ASIAKIRJA</a></body></html>`
				: `<html><body><h1>Sign in to view the shared document</h1><input type="email" id="i0116" placeholder="Email, phone, or Skype"><button>Next</button></body></html>`;
		const hostname = new URL(url).hostname;
		return {
			requestedUrl: options.url,
			url,
			hostname,
			navigationHops: [{ index: 0, url, hostname, status: 200, contentType: "text/html", contentCaptured: true }],
			archivedAt: new Date("2026-11-18T20:08:31Z"),
			route,
			egress,
			mhtml: Buffer.from(`From: <Saved by Blink>\r\nSnapshot-Content-Location: ${url}\r\n\r\n${html}`, "utf8"),
			html: Buffer.from(html, "utf8"),
			text: Buffer.from(text, "utf8"),
			...(report ? {
				session: scriptedVisitSession({
					...(walk ? { steps: [page(walk.to, "challenge", undefined)] } : {}),
					agent: { report: { asksForPhone: false, blockedByChallenge: report.blocked, stoppedReason: report.blocked ? "Cloudflare Turnstile remained after waiting." : "The sign-in asks for an account." } },
				}),
			} : {}),
		};
	};
	return page(options.url, walk ? "note" : shown, { blocked: walk ? true : shown === "challenge" });
}

const NOTHING = { finding: "insufficient_evidence", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], hiddenFrameRef: "", mobileHandoff: false };
const SIGN_IN_PHISHING = { ...NOTHING, finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "Sign in to view the shared document", impersonatedBrand: "Microsoft", brandOfficialUrl: "https://www.microsoft.com" };

/** Classifies the sign-in as phishing and the challenge as showing nothing. */
function model(prompts: string[]): AnalysisClient {
	let call = 0;
	return {
		responses: {
			create: async (options: { input: Array<{ content: unknown }>; text?: unknown }) => {
				const prompt = JSON.stringify(options.input);
				prompts.push(prompt);
				const answer = prompt.includes("Sign in to view the shared document") ? SIGN_IN_PHISHING : NOTHING;
				const text = options.text ? JSON.stringify(answer) : "The page imitates a Microsoft sign-in.";
				call++;
				return (async function* () {
					yield { type: "response.completed", response: { id: `response-${call}`, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { total_tokens: 10 } } };
				})();
			},
		},
	} as unknown as AnalysisClient;
}

type Retry = Shown | "browser outage";

/** Each route shows what `routes` says; a route it does not name cannot reach the page. */
async function analyze(id: bigint, routes: { first: { egress: FabricEgress; shown: Shown; walk?: { to: string } }; retry?: Partial<Record<FabricEgress, Retry>> }) {
	const captures: ArchiveWebsiteOptions[] = [];
	const prompts: string[] = [];
	await SubmissionsEntity.create({ id, kind: "website", data: { kind: "website", website: { url: PAGE } }, dedupeKey: websiteSubmissionDedupeKey(`${PAGE}#${id}`), status: "running", source: PAGE });
	await analyzeWebsite({ submissionId: id, url: PAGE }, {
		getInfo: async () => ({ ip_rdaps: [] }),
		analysisClient: model(prompts),
		timestampEvidence: async () => undefined,
		browserBackoffMs: [1],
		archiveWebsite: async (options) => {
			captures.push(options);
			if (!options.egress) return captured(options, routes.first.shown, routes.first.egress, routes.first.walk);
			const shown = routes.retry?.[options.egress];
			if (shown === "browser outage") throw new BrowserInfrastructureError("Browser service unavailable: the residential exit is offline");
			if (!shown) throw new WebsiteCaptureFailedError([new WebsiteUnreachableError(options.egress, "net::ERR_CONNECTION_CLOSED")]);
			return captured(options, shown, options.egress);
		},
	});
	const submission = await SubmissionsEntity.get(id);
	return { captures, prompts, submission, website: submission?.data.kind === "website" ? submission.data.website : undefined };
}

describe("a visit a CAPTCHA or browser check blocked", () => {
	test("is opened again from the residential exit, whose visit is judged and reported, with the blocked visit as its first hop", async () => {
		const { captures, prompts, submission, website } = await analyze(381535952033550429n, { first: { egress: "phishing", shown: "challenge" }, retry: { residential: "sign-in" } });
		expect(captures.map(({ url, egress }) => ({ url, egress }))).toEqual([{ url: PAGE, egress: undefined }, { url: PAGE, egress: "residential" }]);
		expect(submission?.status).toBe("reported");
		expect(website?.navigationHops?.map(({ index, url, redirectTo, revisit, contentCaptured }) => ({ index, url, redirectTo, revisit, contentCaptured }))).toEqual([
			{ index: 0, url: PAGE, redirectTo: PAGE, revisit: { reason: "challenge", route: "residential exit" }, contentCaptured: false },
			{ index: 1, url: PAGE, redirectTo: undefined, revisit: undefined, contentCaptured: true },
		]);
		// The classifier is told how the page was reached.
		expect(prompts.some((prompt) => prompt.includes("Since a CAPTCHA or browser check blocked our visit from the network it first came from, it was opened again from the residential exit."))).toBeTrue();
	});

	test("that blocks the other network too is inconclusive, never a verdict, and is not opened a third time", async () => {
		const { captures, submission } = await analyze(381535952033550430n, { first: { egress: "phishing", shown: "challenge" }, retry: { residential: "challenge" } });
		expect(captures.map(({ egress }) => egress)).toEqual([undefined, "residential"]);
		expect(submission?.status).toBe("failed");
		expect(submission?.info).toStartWith("Inconclusive: the visit could not finish the site's flow: a CAPTCHA or browser check blocked it (Cloudflare Turnstile remained after waiting.) from the residential exit as well.");
	});

	test("whose other network cannot reach the page stays inconclusive, and says so", async () => {
		const { captures, submission } = await analyze(381535952033550431n, { first: { egress: "phishing", shown: "challenge" } });
		expect(captures.map(({ egress }) => egress)).toEqual([undefined, "residential"]);
		expect(submission?.status).toBe("failed");
		expect(submission?.info).toStartWith("Inconclusive: the visit could not finish the site's flow: a CAPTCHA or browser check blocked it (Cloudflare Turnstile remained after waiting.), and the residential exit could not open the page again (Failed to load page: net::ERR_CONNECTION_CLOSED via residential exit).");
	});

	test("whose other network's browser is out of service keeps the blocked visit's result rather than failing the case", async () => {
		const { captures, submission } = await analyze(381535952033550434n, { first: { egress: "phishing", shown: "challenge" }, retry: { residential: "browser outage" } });
		// The capture's own backoff retried the outage before the visit gave up on the other network.
		expect(captures.map(({ egress }) => egress)).toEqual([undefined, "residential", "residential"]);
		expect(submission?.status).toBe("failed");
		expect(submission?.info).toContain("and the residential exit could not open the page again (Browser service unavailable: the residential exit is offline)");
	});

	test("that already came from the residential exit is not repeated: every other route was decoyed or turned away in that capture", async () => {
		const { captures, submission } = await analyze(381535952033550432n, { first: { egress: "residential", shown: "challenge" }, retry: { reporting: "sign-in" } });
		expect(captures.map(({ egress }) => egress)).toEqual([undefined]);
		expect(submission?.status).toBe("failed");
		expect(submission?.info).toContain("a CAPTCHA or browser check blocked it (Cloudflare Turnstile remained after waiting.).");
	});

	test("on a later page of the flow reopens the page the visit started at, and the hops say which", async () => {
		const challengeUrl = `${PAGE}document`;
		const { captures, website } = await analyze(381535952033550435n, { first: { egress: "phishing", shown: "sign-in", walk: { to: challengeUrl } }, retry: { residential: "sign-in" } });
		expect(captures.map(({ url, egress }) => ({ url, egress }))).toEqual([{ url: PAGE, egress: undefined }, { url: PAGE, egress: "residential" }]);
		expect(website?.navigationHops?.map(({ url, redirectTo, revisit }) => ({ url, redirectTo, revisit }))).toEqual([
			{ url: PAGE, redirectTo: challengeUrl, revisit: undefined },
			{ url: challengeUrl, redirectTo: PAGE, revisit: { reason: "challenge", route: "residential exit" } },
			{ url: PAGE, redirectTo: undefined, revisit: undefined },
		]);
	});

	test("a visit no challenge blocked is not repeated", async () => {
		const { captures, submission } = await analyze(381535952033550433n, { first: { egress: "phishing", shown: "sign-in" } });
		expect(captures).toHaveLength(1);
		expect(submission?.status).toBe("reported");
	});
});
