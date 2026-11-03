import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import type { AnalysisClient } from "./analysis_run";
import { AbuseRepository } from "./abuse/repository";
import { ArtifactsEntity, SubmissionsEntity } from "./db/entities";
import { useTemporaryDatabase } from "./db/test_helpers";
import { retryFailedWebsiteAnalysis, websiteSubmissionDedupeKey } from "./submissions/website";
import { capturedDocumentContent, WebsiteCaptureFailedError, WebsiteUnreachableError, type ArchiveWebsiteOptions, type WebsiteArchiveResult } from "./website_archive";
import { analyzeWebsite, buildWebsiteClassificationInput, buildWebsiteReportEvidence, followedNavigation, websiteContinuationLink, type WebsiteAnalysisDependencies } from "./website_ai";
import { extractWebsiteContinuationLinks } from "./website_fields";
import type { WebsiteNavigationHop } from "./website_types";

useTemporaryDatabase();

/**
 * The MetaMask recovery-phrase kit of submission 375914181917937690, as the
 * browser rendered it: a consent page, a "get started" page, and the page that
 * asks for the Secret Recovery Phrase (its 12 word fields are drawn by script).
 */
const SITE = "https://moz-extensionkeplrr-pudgbhnp-avds-projects-gnhfnp-avds-projects.vercel.app";
const CONSENT = `${SITE}/`;
const GET_STARTED = `${SITE}/Access.html`;
const RECOVERY = `${SITE}/secure.html`;

const PAGES: Record<string, string> = {
	[CONSENT]: `<html lang="en"><head><title>MetaMask</title></head><body>
<div class="top-bar"><div><img src="https://metamask2-eight.vercel.app/meta.png" alt="cbcLogo"></div>
<select class="language-select"><option value="en">English</option><option value="fr">Français</option></select></div>
<main><div class="card"><h1 id="title">Help us improve MetaMask</h1>
<p id="desc1">We’d like to gather basic usage and diagnostics data to improve MetaMask. Know that we never sell the data you provide here.</p>
<p><a href="https://metamask.io/privacy.html" target="_blank">Learn how we protect your privacy while collecting usage data for your profile.</a></p>
<div class="checkbox"><input type="checkbox" id="checkbox"><label for="checkbox">We’ll use this data to learn how you interact with our marketing communications.</label></div>
<div class="buttons"><button class="no-btn">No thanks</button><a href="${GET_STARTED}" class="yes-btn">I agree</a></div>
</div></main></body></html>`,
	[GET_STARTED]: `<html lang="en"><head><title>MetaMask - Get Started</title></head><body>
<main><div class="card"><h1>Let's get started</h1>
<p class="subtitle">Trusted by millions, MetaMask is a secure wallet making the world of web3 accessible to all.</p>
<div class="checkbox"><label><input type="checkbox" id="agreeBox"> I agree to MetaMask's <a href="#">Terms of use</a></label></div>
<div class="buttons"><a href="secure.html" class="primary-btn disabled" id="createBtn">Import an existing wallet</a>
<a href="secure.html" class="secondary-btn disabled" id="importBtn">Create a new wallet</a></div>
</div></main></body></html>`,
	[RECOVERY]: `<html lang="en"><head><title>MetaMask</title></head><body>
<main><div class="card"><div class="step-circles"><div class="label">Confirm secret<br>recovery phrase</div><div class="label">Create<br>password</div></div>
<h1>Access your wallet with your Secret Recovery Phrase</h1>
<p class="description">MetaMask cannot recover your password. We will use your Secret Recovery Phrase to validate your ownership, restore your wallet and set up a new password.</p>
<select class="phrase-length" id="phraseLength"><option value="12">I have a 12 word phrase</option></select>
<div class="info">🔐 You can paste your entire secret recovery phrase into any field</div>
<div class="seed-inputs" id="seedInputs">${Array.from({ length: 12 }, (_, index) => `<div class="seed-input"><label>${index + 1}.</label><input type="text" name="word${index + 1}" autocomplete="off"></div>`).join("")}</div>
<button class="submit-btn" id="submitBtn" disabled>Confirm Secret Recovery Phrase</button>
</div></main></body></html>`,
};

const PNG = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#ffffff" } })
	.composite([{ input: { create: { width: 16, height: 8, channels: 3, background: "#202124" } }, top: 8, left: 8 }])
	.png().toBuffer();

function liveCapture(url: string, hops?: WebsiteNavigationHop[]): WebsiteArchiveResult {
	const captured = hops?.at(-1)?.url ?? url;
	const { html, text } = capturedDocumentContent(PAGES[captured]!);
	return {
		requestedUrl: url,
		url: captured,
		hostname: new URL(captured).hostname,
		navigationHops: hops ?? [{ index: 0, url, hostname: new URL(url).hostname, status: 200, contentType: "text/html", contentCaptured: true }],
		archivedAt: new Date("2026-11-03T07:48:00Z"),
		route: "Tor exit",
		screenshotPng: PNG,
		mhtml: Buffer.from(`From: <Saved by Blink>\r\nSnapshot-Content-Location: ${captured}\r\n\r\n${PAGES[captured]}`, "utf8"),
		html: Buffer.from(html, "utf8"),
		text: Buffer.from(text, "utf8"),
		kitResources: [{ url: `${captured}#kit`, mimeType: "application/javascript", size: 2_000, sha256: captured === RECOVERY ? "b".repeat(64) : "a".repeat(64) }],
	};
}

type ClassifierAnswers = Record<string, Record<string, unknown>>;

/** What the classifier answers for each page of the kit. */
const KIT_ANSWERS: ClassifierAnswers = {
	[CONSENT]: { finding: "insufficient_evidence", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], continuationRef: "l1" },
	[GET_STARTED]: { finding: "insufficient_evidence", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], continuationRef: "L1 " },
	[RECOVERY]: {
		finding: "phishing",
		phishingBasis: "credential_theft",
		evidenceQuote: "Access your wallet with your Secret Recovery Phrase",
		collectionFieldRefs: ["f2", "f3"],
		continuationRef: "",
	},
};

/** Answers each classification by the page it is shown and writes a narrative for the analyzed page. */
function kitModel(answers: ClassifierAnswers, calls: Array<{ kind: "classification" | "analysis"; url: string }> = []): AnalysisClient {
	let call = 0;
	return {
		responses: {
			create: async (options: { input: Array<{ content: unknown }>; text?: unknown }) => {
				const prompt = JSON.stringify(options.input);
				const classification = Boolean(options.text);
				const url = classification
					? prompt.match(/Exact captured target URL: (\S+?)\\n/)![1]!
					: prompt.match(/The page content below belongs only to this final URL: (\S+?)\\n/)![1]!;
				calls.push({ kind: classification ? "classification" : "analysis", url });
				const text = classification ? JSON.stringify(answers[url]) : `The page at ${url} asks for a MetaMask recovery phrase.`;
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

function dependencies(params: {
	answers?: ClassifierAnswers;
	captures: ArchiveWebsiteOptions[];
	modelCalls?: Array<{ kind: "classification" | "analysis"; url: string }>;
	capture?: (options: ArchiveWebsiteOptions) => WebsiteArchiveResult;
}): WebsiteAnalysisDependencies {
	return {
		getInfo: async () => ({ ip_rdaps: [] }),
		analysisClient: kitModel(params.answers ?? KIT_ANSWERS, params.modelCalls),
		timestampEvidence: async () => undefined,
		browserBackoffMs: [1],
		archiveWebsite: async (options) => {
			params.captures.push(options);
			return params.capture ? params.capture(options) : liveCapture(options.url);
		},
	};
}

async function websiteSubmission(id: bigint, url: string) {
	return SubmissionsEntity.create({ id, kind: "website", data: { kind: "website", website: { url } }, dedupeKey: websiteSubmissionDedupeKey(url), status: "running", source: url });
}

function websiteData(submission: Awaited<ReturnType<typeof SubmissionsEntity.get>>) {
	return submission?.data.kind === "website" ? submission.data.website : undefined;
}

describe("continuation links", () => {
	test("only links to other pages of the same site are listed, once per page", () => {
		const html = `<base href="${SITE}/app/">
<a href="${SITE}/app/">this page</a><a href="#top">top</a>
<a href="step2.html">Continue</a><a href="step2.html#form">Continue again</a>
<a href="/terms"><img alt="Terms of use"></a>
<a href="https://metamask.io/privacy.html">Privacy</a>
<a href="mailto:help@example.com">Mail</a><a href="javascript:void(0)">Nothing</a>
<a href="/kit.zip" download>Download</a>
<area href="/map-target" alt="Map">`;
		expect(extractWebsiteContinuationLinks(html, `${SITE}/app/`)).toEqual([
			{ ref: "l1", label: "Continue", url: `${SITE}/app/step2.html` },
			{ ref: "l2", label: "Terms of use", url: `${SITE}/terms` },
			{ ref: "l3", label: "Map", url: `${SITE}/map-target` },
		]);
	});

	test("on a shared host, another tenant's pages are another site", () => {
		const html = '<a href="/view/kit/login">Sign in</a><a href="/view/other-site/">Other</a>';
		expect(extractWebsiteContinuationLinks(html, "https://sites.google.com/view/kit")).toEqual([
			{ ref: "l1", label: "Sign in", url: "https://sites.google.com/view/kit/login" },
		]);
	});

	test("the classifier can only name one of the page's own links", () => {
		const html = capturedDocumentContent(PAGES[CONSENT]!).html;
		expect(websiteContinuationLink({ continuationRef: " L1" }, html, CONSENT)).toEqual({ ref: "l1", label: "I agree", url: GET_STARTED });
		// The privacy link goes to another site and is never a step of the kit's flow.
		expect(websiteContinuationLink({ continuationRef: "l2" }, html, CONSENT)).toBeUndefined();
		expect(websiteContinuationLink({ continuationRef: "" }, html, CONSENT)).toBeUndefined();
		expect(websiteContinuationLink({}, html, CONSENT)).toBeUndefined();
	});

	test("a followed page records the link that opened it and how the visitor got there", () => {
		const consent = liveCapture(CONSENT);
		const next = liveCapture(GET_STARTED);
		const hops = followedNavigation(consent.navigationHops, consent.navigationHops[0]!, { ref: "l1", label: "I agree", url: GET_STARTED }, next.navigationHops);
		expect(hops).toEqual([
			{ index: 0, url: CONSENT, hostname: new URL(SITE).hostname, status: 200, contentType: "text/html", redirectTo: GET_STARTED, followedLink: { label: "I agree" }, contentCaptured: false },
			{ index: 1, url: GET_STARTED, hostname: new URL(SITE).hostname, status: 200, contentType: "text/html", contentCaptured: true },
		]);

		const input = buildWebsiteClassificationInput(hops[1]!, { ...next, navigationHops: hops });
		const text = (input[1]!.content as Array<{ text?: string }>)[0]!.text!;
		expect(text).toContain(`The visitor reaches this page by following the link "I agree" on ${CONSENT}, an earlier page of the same site.`);
		expect(text).toContain(`continuation_links[1]{ref,label,url}:\n  l1,Import an existing wallet,"${RECOVERY}"`);
		const system = input[0]!.content as string;
		expect(system).toContain("set continuationRef to the ref of the link a visitor follows to continue that flow");
		expect(system).toContain("a wallet recovery phrase or private key");

		expect(buildWebsiteReportEvidence(
			{ finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "Access your wallet with your Secret Recovery Phrase" },
			[],
			[...hops.slice(0, 1), { ...hops[1]!, contentCaptured: false, redirectTo: RECOVERY, followedLink: { label: "Import an existing wallet" } }, { index: 2, url: RECOVERY, hostname: new URL(SITE).hostname, status: 200, contentCaptured: true }],
		)).toBe([
			"The page impersonates a trusted brand and asks visitors for a password, sign-in details, a verification code, or identity details, or leads them to a step that does.",
			`Visitors reach the page through the site's own earlier pages: the link "I agree" on ${CONSENT}, then the link "Import an existing wallet" on ${GET_STARTED}.`,
			'Page text that shows it, in its original language: "Access your wallet with your Secret Recovery Phrase".',
		].join("\n"));
	});
});

describe("multi-page kits", () => {
	test("the MetaMask kit is followed from its consent page to the recovery-phrase form and reported with every page", async () => {
		const captures: ArchiveWebsiteOptions[] = [];
		const modelCalls: Array<{ kind: "classification" | "analysis"; url: string }> = [];
		const id = await websiteSubmission(375914181917937690n, CONSENT);

		await analyzeWebsite({ submissionId: id, url: CONSENT }, dependencies({ captures, modelCalls }));

		// Each link is opened as a visitor would: from the page that shows it.
		expect(captures.map(({ url, referrer }) => ({ url, referrer }))).toEqual([
			{ url: CONSENT, referrer: undefined },
			{ url: GET_STARTED, referrer: CONSENT },
			{ url: RECOVERY, referrer: GET_STARTED },
		]);
		// Every page is classified; the narrative describes the page the flow ends on.
		expect(modelCalls).toEqual([
			{ kind: "classification", url: CONSENT },
			{ kind: "classification", url: GET_STARTED },
			{ kind: "classification", url: RECOVERY },
			{ kind: "analysis", url: RECOVERY },
		]);

		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("reported");
		expect(submission?.info).toBe(`Phishing confirmed at ${RECOVERY}; evidence for it and the 2 URLs on ${new URL(SITE).hostname} that lead to it is being collected before the report is sent.`);
		const website = websiteData(submission);
		expect(website?.archiveUrl).toBe(RECOVERY);
		expect(website?.navigationHops?.map(({ index, url, redirectTo, followedLink, contentCaptured }) => ({ index, url, redirectTo, followedLink, contentCaptured }))).toEqual([
			{ index: 0, url: CONSENT, redirectTo: GET_STARTED, followedLink: { label: "I agree" }, contentCaptured: false },
			{ index: 1, url: GET_STARTED, redirectTo: RECOVERY, followedLink: { label: "Import an existing wallet" }, contentCaptured: false },
			{ index: 2, url: RECOVERY, redirectTo: undefined, followedLink: undefined, contentCaptured: true },
		]);
		expect(website?.siteAssessments?.map(({ hopIndex, finding }) => ({ hopIndex, finding }))).toEqual([
			{ hopIndex: 0, finding: "phishing" },
			{ hopIndex: 1, finding: "phishing" },
			{ hopIndex: 2, finding: "phishing" },
		]);
		expect(website?.siteAssessments?.[2]).toMatchObject({
			phishingBasis: "credential_theft",
			evidenceQuote: "Access your wallet with your Secret Recovery Phrase",
			collectionFields: [{ ref: "f2", name: "word1" }, { ref: "f3", name: "word2" }],
		});
		// The kit files of every page are kept for sibling discovery, once per hash.
		expect(website?.kitResources?.map(({ sha256 }) => sha256)).toEqual(["a".repeat(64), "b".repeat(64)]);

		// Every page is evidence with its own stamped screenshot and manifest.
		const artifacts = await ArtifactsEntity.listForSubmission(id);
		expect(artifacts.map(({ name }) => name).sort()).toEqual([
			"evidence-manifest.json",
			"evidence-step2-manifest.json",
			"evidence-step3-manifest.json",
			"website-stamped.png",
			"website-step2-stamped.png",
			"website-step2.mhtml",
			"website-step2.png",
			"website-step3-stamped.png",
			"website-step3.mhtml",
			"website-step3.png",
			"website.mhtml",
			"website.png",
		]);
		const manifest = JSON.parse((await ArtifactsEntity.get(artifacts.find(({ name }) => name === "evidence-step3-manifest.json")!.id))!.blob.toString("utf8"));
		expect(manifest.capture.capturedUrl).toBe(RECOVERY);
		expect(manifest.files.map(({ name }: { name: string }) => name)).toEqual(["website-step3.png", "website-step3-stamped.png", "website-step3.mhtml"]);
		expect(manifest.capture.navigation[1]).toMatchObject({ url: GET_STARTED, followedLink: { label: "Import an existing wallet" } });

		// The report names all three pages, the form first, and shows each page.
		const report = await AbuseRepository.getReportForSubmission(id);
		const targets = await AbuseRepository.listTargets(report!.id);
		expect(targets.map(({ normalizedTarget, observedUrls }) => ({ normalizedTarget, observedUrls }))).toEqual([
			{ normalizedTarget: new URL(SITE).hostname, observedUrls: [RECOVERY, CONSENT, GET_STARTED] },
		]);
		const input = await AbuseRepository.getReportInput(report!.id);
		expect(input?.evidenceArtifacts.map(({ name }) => name)).toEqual(["website-step3.png", "website.png", "website-step2.png"]);
		expect(report!.description).toContain(`Visitors reach the page through the site's own earlier pages: the link "I agree" on ${CONSENT}, then the link "Import an existing wallet" on ${GET_STARTED}.`);
	});

	test("a retry reuses the analyzed page's own capture, not the first page's", async () => {
		const id = await websiteSubmission(375914181917937691n, CONSENT);
		const unconfirmed = { ...KIT_ANSWERS, [RECOVERY]: { finding: "insufficient_evidence", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], continuationRef: "" } };
		await analyzeWebsite({ submissionId: id, url: CONSENT }, dependencies({ answers: unconfirmed, captures: [] }));
		// As if the analysis had failed after its captures: the case is retryable.
		await SubmissionsEntity.update(id, { status: "failed" });

		const started: Array<Parameters<typeof analyzeWebsite>[0]> = [];
		await retryFailedWebsiteAnalysis(id, async (options) => { started.push(options); });
		expect(started).toHaveLength(1);
		expect(started[0]!.archivedUrl).toBe(RECOVERY);
		expect(started[0]!.mhtmlSnapshot?.toString("utf8")).toContain(`Snapshot-Content-Location: ${RECOVERY}`);
		expect(started[0]!.reuseEvidenceArtifacts).toBe(true);
		expect(started[0]!.navigationHops?.filter((hop) => hop.followedLink)).toHaveLength(2);
	});

	test("a link that cannot be loaded leaves the last page reached as the finding and says why", async () => {
		const id = await websiteSubmission(375914181917937692n, CONSENT);
		const unreachable = new WebsiteCaptureFailedError([new WebsiteUnreachableError("phishing", "HTTP 404")]);

		await analyzeWebsite({ submissionId: id, url: CONSENT }, dependencies({
			captures: [],
			capture: (options) => {
				if (options.url === GET_STARTED) throw unreachable;
				return liveCapture(options.url);
			},
		}));

		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("invalid");
		expect(submission?.info).toBe(`No reportable phishing or malware evidence was found at the captured destination ${CONSENT}; no report was created. The capture stopped following the site's flow: its link "I agree" to ${GET_STARTED} could not be loaded (${unreachable.message}).`);
		expect(websiteData(submission)?.navigationHops).toHaveLength(1);
		expect((await ArtifactsEntity.listForSubmission(id)).map(({ name }) => name)).not.toContain("website-step2.mhtml");
	});

	test("a link whose page ends on another site is not followed into it", async () => {
		const id = await websiteSubmission(375914181917937693n, CONSENT);
		const elsewhere = "https://wallet-restore.example.net/";
		PAGES[elsewhere] = "<html><body><h1>Restore</h1></body></html>";

		await analyzeWebsite({ submissionId: id, url: CONSENT }, dependencies({
			captures: [],
			capture: (options) => options.url === GET_STARTED
				? liveCapture(options.url, [
					{ index: 0, url: GET_STARTED, hostname: new URL(SITE).hostname, status: 302, redirectTo: elsewhere, contentCaptured: false },
					{ index: 1, url: elsewhere, hostname: "wallet-restore.example.net", status: 200, contentCaptured: true },
				])
				: liveCapture(options.url),
		}));

		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("invalid");
		expect(submission?.info).toEndWith(`The capture stopped following the site's flow: its link "I agree" to ${GET_STARTED} led to another site, wallet-restore.example.net.`);
		expect(websiteData(submission)?.archiveUrl).toBe(CONSENT);
	});

	test("a link back to a page already captured, or past the follow limit, is not followed", async () => {
		const loopId = await websiteSubmission(375914181917937694n, CONSENT);
		const loopCaptures: ArchiveWebsiteOptions[] = [];
		const consentHtml = capturedDocumentContent(PAGES[GET_STARTED]!.replace('href="secure.html"', `href="${CONSENT}"`)).html;
		await analyzeWebsite({ submissionId: loopId, url: CONSENT }, dependencies({
			captures: loopCaptures,
			capture: (options) => options.url === GET_STARTED ? { ...liveCapture(options.url), html: Buffer.from(consentHtml, "utf8") } : liveCapture(options.url),
		}));
		expect(loopCaptures.map(({ url }) => url)).toEqual([CONSENT, GET_STARTED]);
		expect((await SubmissionsEntity.get(loopId))?.info).toEndWith(`its link "Import an existing wallet" to ${CONSENT} leads back to a page already captured.`);

		// A site whose every page links on stops after three followed links.
		const pages = Array.from({ length: 6 }, (_, index) => `${SITE}/page-${index}.html`);
		pages.forEach((page, index) => { PAGES[page] = `<html><body><h1>MetaMask step ${index}</h1><a href="${pages[index + 1] ?? pages[0]}">Next</a></body></html>`; });
		const endless: ClassifierAnswers = Object.fromEntries(pages.map((page) => [page, { finding: "insufficient_evidence", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], continuationRef: "l1" }]));
		const endlessCaptures: ArchiveWebsiteOptions[] = [];
		const endlessId = await websiteSubmission(375914181917937695n, pages[0]!);
		await analyzeWebsite({ submissionId: endlessId, url: pages[0]! }, dependencies({ answers: endless, captures: endlessCaptures }));
		expect(endlessCaptures.map(({ url }) => url)).toEqual(pages.slice(0, 4));
		const endlessCase = await SubmissionsEntity.get(endlessId);
		expect(endlessCase?.status).toBe("invalid");
		expect(endlessCase?.info).toEndWith(`its link "Next" to ${pages[4]} was not followed after 3 followed links.`);
	});
});
