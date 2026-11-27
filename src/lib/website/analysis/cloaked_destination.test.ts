import { describe, expect, test } from "bun:test";

import type { AnalysisClient } from "../../analysis/run";
import { FABRIC_EGRESS_LABEL, type FabricEgress } from "../../browser/fabric";
import { SubmissionsEntity } from "../../db/entities/submissions";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { scriptedSiteVisit, type ScriptedPage, type ScriptedVisit } from "../../site_visit/test_helpers";
import { websiteSubmissionDedupeKey } from "../../submissions/website";
import { analyzeWebsite } from "./ai";
import type { WebsiteAnalysisDependencies } from "./analysis_types";
import { WebsiteCaptureFailedError, WebsiteUnreachableError } from "../archive/errors";
import { cloakedDestination } from "../archive/cloaking";
import type { SiteVisitOptions, WebsiteArchiveResult } from "../archive/types";
import type { CapturedNetworkRequest } from "../../exfiltration/types";
import type { WebsiteNavigationHop } from "../types";
import { navigationHop } from "../test_helpers";

useTemporaryDatabase();

/**
 * Production case 382166397712601140: a Google Cloud Storage page ("Slide to
 * verify") sends the visitor on to an affiliate traffic distribution system,
 * which answered the Tor exit with an empty 204 and sent it back to the page.
 * The flow is walked again through every other network before giving up.
 */
const LURE = "https://storage.googleapis.com/tyhfghwsdfvgqgfqghsd/lis";
const TDS = "https://www.solidfairhubhost.com/5ZQZW1S/27KQBZNB/?sub1=soufian&sub2=18";
const LANDING = "https://www.solidfairhubhost.com/offer/login";
const LURE_TEXT = "Please verify you are human\nSlide to verify";
const LANDING_TEXT = "Sign in to your account\nEmail\nPassword";

type Answer = "cloaked" | "landing" | "unreachable";


function page(url: string, text: string, navigationHops: WebsiteNavigationHop[], egress: FabricEgress, walk?: ScriptedVisit): ScriptedPage {
	const html = `<html><body><p>${text}</p></body></html>`;
	return {
		requestedUrl: LURE,
		url,
		hostname: new URL(url).hostname,
		navigationHops,
		archivedAt: new Date("2026-11-18T20:08:31Z"),
		route: FABRIC_EGRESS_LABEL[egress],
		egress,
		mhtml: Buffer.from(`From: <Saved by Blink>\r\nSnapshot-Content-Location: ${url}\r\n\r\n${html}`, "utf8"),
		html: Buffer.from(html, "utf8"),
		text: Buffer.from(text, "utf8"),
		...(walk ? { walk } : {}),
	};
}

/** What the visit's agent saw after passing the gate: the destination's answer to this network, as the hops record it. */
type Flow = (egress: FabricEgress) => { steps: WebsiteArchiveResult[]; requests?: CapturedNetworkRequest[] };

const afterGate = (answer: "cloaked" | "landing", egress: FabricEgress): WebsiteArchiveResult[] => [
	answer === "cloaked"
		? page(LURE, LURE_TEXT, [navigationHop(0, TDS, { status: 204, redirectTo: LURE }), navigationHop(1, LURE, { status: 200, contentCaptured: true })], egress)
		: page(LANDING, LANDING_TEXT, [navigationHop(0, LANDING, { status: 200, contentCaptured: true })], egress),
];

function lure(options: SiteVisitOptions, egress: FabricEgress, flow: Flow): ScriptedPage {
	const { steps, requests } = flow(egress);
	return page(options.url, LURE_TEXT, [navigationHop(0, options.url, { status: 200, contentCaptured: true })], egress, { steps, ...(requests ? { requests: () => requests } : {}) });
}

const NOTHING = { finding: "insufficient_evidence", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], hiddenFrameRef: "", mobileHandoff: false };

function model(): AnalysisClient {
	let call = 0;
	return {
		responses: {
			create: async (options: { text?: unknown }) => {
				call++;
				const text = options.text ? JSON.stringify(NOTHING) : "Nothing reportable was found.";
				return (async function* () {
					yield { type: "response.completed", response: { id: `response-${call}`, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { total_tokens: 10 } } };
				})();
			},
		},
	} as unknown as AnalysisClient;
}

/** `first` is what the plain capture (residential exit first) walks; `retries` what each other network's walk finds. */
async function analyze(id: bigint, answers: { first: Flow; retries?: Partial<Record<FabricEgress, Flow | "unreachable">> }, extra: Partial<WebsiteAnalysisDependencies> = {}) {
	const captures: SiteVisitOptions[] = [];
	await SubmissionsEntity.create({ id, kind: "website", data: { kind: "website", website: { url: LURE } }, dedupeKey: websiteSubmissionDedupeKey(`${LURE}#${id}`), status: "running", source: LURE });
	await analyzeWebsite({ submissionId: id, url: LURE }, {
		getInfo: async () => ({ ip_rdaps: [] }),
		analysisClient: model(),
		domainRegistration: async () => undefined,
		timestampEvidence: async () => undefined,
		browserBackoffMs: [1],
		visitSite: scriptedSiteVisit((options) => {
			if (!options.egress) return lure(options, "residential", answers.first);
			const flow = answers.retries?.[options.egress];
			if (!flow || flow === "unreachable") throw new WebsiteCaptureFailedError([new WebsiteUnreachableError(options.egress, "net::ERR_CONNECTION_CLOSED")]);
			return lure(options, options.egress, flow);
		}, { calls: captures }),
		// Rotation sampling is covered by rotation.test.ts.
		rotationBudgetMs: 0,
		...extra,
	});
	const submission = await SubmissionsEntity.get(id);
	return { captures, submission, website: submission?.data.kind === "website" ? submission.data.website : undefined };
}

const cloaked: Flow = (egress) => ({ steps: afterGate("cloaked", egress) });
const landing: Flow = (egress) => ({ steps: afterGate("landing", egress) });

describe("a flow whose destination answers empty and sends the visit back", () => {
	test("is walked again from the next network, and a destination that shows content there is judged in the same case", async () => {
		const { captures, submission, website } = await analyze(382166397712601140n, { first: cloaked, retries: { phishing: "unreachable", reporting: landing } });
		expect(captures.map(({ url, egress }) => ({ url, egress }))).toEqual([{ url: LURE, egress: undefined }, { url: LURE, egress: "phishing" }, { url: LURE, egress: "reporting" }]);
		// The destination showed its page, judged as its own site's: nothing reportable, a verdict and no cloaking.
		expect(submission?.status).toBe("invalid");
		expect(submission?.info).toBe(`No reportable phishing or malware evidence was found at the captured destination ${LANDING}; no report was created.`);
		expect(website?.cloakedDestination).toBeUndefined();
		expect(website?.rotation?.ended).toBe("The time for sampling the link's other offers (0 min) was used up.");
		expect(website?.routes![0]!.siteAssessments?.map(({ hopIndex, finding, judgedHopIndex }) => ({ hopIndex, finding, judgedHopIndex }))).toEqual([
			{ hopIndex: 0, finding: "insufficient_evidence", judgedHopIndex: 3 },
			{ hopIndex: 1, finding: "insufficient_evidence", judgedHopIndex: 4 },
			{ hopIndex: 2, finding: "insufficient_evidence", judgedHopIndex: 3 },
			{ hopIndex: 3, finding: "insufficient_evidence", judgedHopIndex: 3 },
			{ hopIndex: 4, finding: "insufficient_evidence", judgedHopIndex: 4 },
		]);
		expect(website?.routes![0]!.hops?.map(({ index, url, status, redirectTo, revisit, visitorStep, contentCaptured }) => ({ index, url, status, redirectTo, revisit, moved: Boolean(visitorStep), contentCaptured }))).toEqual([
			{ index: 0, url: LURE, status: 200, redirectTo: TDS, revisit: undefined, moved: true, contentCaptured: false },
			{ index: 1, url: TDS, status: 204, redirectTo: LURE, revisit: undefined, moved: false, contentCaptured: false },
			{ index: 2, url: LURE, status: 200, redirectTo: LURE, revisit: { reason: "destination_cloaked", route: "server IP", site: "solidfairhubhost.com" }, moved: false, contentCaptured: false },
			{ index: 3, url: LURE, status: 200, redirectTo: LANDING, revisit: undefined, moved: true, contentCaptured: false },
			{ index: 4, url: LANDING, status: 200, redirectTo: undefined, revisit: undefined, moved: false, contentCaptured: true },
		]);
		expect(website?.routes![0]!.hops?.at(-1)?.url).toBe(LANDING);
	});

	test("goes on to the server IP when Tor is cloaked too, in the order residential, Tor, server IP", async () => {
		const { captures, submission } = await analyze(382166397712601141n, { first: cloaked, retries: { phishing: cloaked, reporting: landing } });
		expect(captures.map(({ egress }) => egress)).toEqual([undefined, "phishing", "reporting"]);
		expect(submission?.status).toBe("invalid");
		expect(submission?.data.kind === "website" ? submission.data.website.cloakedDestination : undefined).toBeUndefined();
	});

	test("that no network gets past finishes plainly, records which networks answered empty, and creates no report", async () => {
		const { captures, submission, website } = await analyze(382166397712601142n, { first: cloaked, retries: { phishing: cloaked, reporting: cloaked } });
		expect(captures.map(({ egress }) => egress)).toEqual([undefined, "phishing", "reporting"]);
		expect(submission?.status).toBe("invalid");
		expect(submission?.info).toBe("The site's flow leads to www.solidfairhubhost.com, which answered every network we tried (residential exit, Tor exit, server IP) with an empty response and sent the visit back; no report was created.");
		expect(submission?.info).not.toContain("No reportable");
		expect(website?.cloakedDestination).toEqual({ host: "www.solidfairhubhost.com", site: "solidfairhubhost.com", answered: ["residential exit", "Tor exit", "server IP"], notTried: [] });
	});

	test("names a network that could not be reached instead of claiming it answered", async () => {
		const { submission, website } = await analyze(382166397712601143n, { first: cloaked, retries: { phishing: cloaked, reporting: "unreachable" } });
		expect(submission?.status).toBe("invalid");
		expect(submission?.info).toContain("answered every network we tried (residential exit, Tor exit)");
		expect(submission?.info).toContain("The server IP could not be tried: Failed to load page: net::ERR_CONNECTION_CLOSED via server IP.");
		expect(website?.cloakedDestination?.notTried).toEqual([{ network: "server IP", reason: "Failed to load page: net::ERR_CONNECTION_CLOSED via server IP" }]);
	});

	test("is not walked again once the time budget is used up, and says so", async () => {
		const { captures, submission, website } = await analyze(382166397712601144n, { first: cloaked, retries: { phishing: landing } }, { cloakedFlowBudgetMs: 0 });
		expect(captures).toHaveLength(1);
		expect(submission?.status).toBe("invalid");
		expect(website?.cloakedDestination?.answered).toEqual(["residential exit"]);
		expect(website?.cloakedDestination?.notTried.map(({ network }) => network)).toEqual(["Tor exit", "server IP"]);
		expect(submission?.info).toContain("The Tor exit could not be tried: the time budget for walking the flow again was used up.");
	});
});

describe("flows that are not cloaked by their destination", () => {
	const sameSite204: Flow = (egress) => ({ steps: [page(LURE, LURE_TEXT, [navigationHop(0, `${LURE}/beacon`, { status: 204, redirectTo: LURE }), navigationHop(1, LURE, { status: 200, contentCaptured: true })], egress)] });
	const sameSiteRedirect: Flow = (egress) => ({ steps: [page(LURE, LURE_TEXT, [navigationHop(0, `${LURE}/go`, { status: 302, redirectTo: LURE }), navigationHop(1, LURE, { status: 200, contentCaptured: true })], egress)] });
	const otherSite302: Flow = (egress) => ({ steps: [page(LURE, LURE_TEXT, [navigationHop(0, "https://bit.ly/abc", { status: 302, redirectTo: LURE }), navigationHop(1, LURE, { status: 200, contentCaptured: true })], egress)] });
	const beacon: Flow = (egress) => ({
		steps: [],
		requests: [{ url: "https://www.google-analytics.com/collect", method: "POST", status: 204, timestamp: "", headers: {}, resourceType: "xhr" } as unknown as CapturedNetworkRequest],
	});

	for (const [name, flow] of [["a same-site 204", sameSite204], ["a same-site redirect", sameSiteRedirect], ["an ordinary redirect through another site", otherSite302], ["an in-page 204 beacon request", beacon], ["a page with no further navigation", (() => ({ steps: [] })) as Flow]] as const) {
		test(`${name} is not retried`, async () => {
			const { captures, submission, website } = await analyze(BigInt(382166397712601200n) + BigInt(name.length), { first: flow, retries: { reporting: landing, residential: landing } });
			expect(captures).toHaveLength(1);
			expect(submission?.status).toBe("invalid");
			expect(website?.cloakedDestination).toBeUndefined();
			expect(submission?.info).not.toContain("answered every network");
		});
	}
});

describe("cloakedDestination", () => {
	const lureHop = navigationHop(0, LURE, { status: 200, redirectTo: TDS, visitorStep: { submitted: [] } });
	test("recognizes the production hops", () => {
		expect(cloakedDestination([lureHop, navigationHop(1, TDS, { status: 204, redirectTo: LURE }), navigationHop(2, LURE, { status: 200, contentCaptured: true })], LURE)).toEqual({ host: "www.solidfairhubhost.com", site: "solidfairhubhost.com" });
	});
	test("recognizes a 2xx that moves on at once, and an empty answer the flow ends on", () => {
		expect(cloakedDestination([lureHop, navigationHop(1, TDS, { status: 200, redirectTo: LURE })], LURE)?.site).toBe("solidfairhubhost.com");
		expect(cloakedDestination([lureHop, navigationHop(1, TDS, { status: 204 })], LURE)?.site).toBe("solidfairhubhost.com");
	});
	test("ignores a destination that shows a page, a redirect chain, an empty answer that moves on elsewhere, and a 204 not reached from the submitted site", () => {
		expect(cloakedDestination([lureHop, navigationHop(1, TDS, { status: 200, contentCaptured: true })], LURE)).toBeUndefined();
		expect(cloakedDestination([lureHop, navigationHop(1, TDS, { status: 302, redirectTo: LURE })], LURE)).toBeUndefined();
		expect(cloakedDestination([lureHop, navigationHop(1, TDS, { status: 204, redirectTo: "https://news.example.com/" })], LURE)).toBeUndefined();
		expect(cloakedDestination([navigationHop(0, "https://short.example/x", { status: 302, redirectTo: TDS }), navigationHop(1, TDS, { status: 204, redirectTo: LURE })], LURE)).toBeUndefined();
	});

	test("ignores a page the visitor was shown and moved on from, back through the submitted tracker", () => {
		// The affiliate's own Voluum link shows the lure, whose button goes back through the same tracker to the offer.
		const tracker = "https://wtrck.com/4df5378b?s1=128";
		const lure = "https://ultimateprizesearch.com/exit.html";
		const click = "https://wtrck.com/click/1?cep=abc";
		const hops = [
			navigationHop(0, tracker, { status: 302, redirectTo: lure }),
			navigationHop(1, lure, { status: 200, redirectTo: click, visitorStep: { submitted: [] } }),
			navigationHop(2, click, { status: 302, redirectTo: "https://www.zatos.com/checkout" }),
			navigationHop(3, "https://www.zatos.com/checkout", { status: 200, contentCaptured: true }),
		];
		expect(cloakedDestination(hops, tracker)).toBeUndefined();
		// The same page answering by script alone, with nothing for the visitor to act on, still is an empty answer.
		expect(cloakedDestination([hops[0]!, { ...hops[1]!, visitorStep: undefined }, hops[2]!], tracker)).toEqual({ host: "ultimateprizesearch.com", site: "ultimateprizesearch.com" });
	});
});
