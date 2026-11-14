import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import type { AnalysisClient } from "./analysis_run";
import { AbuseRepository } from "./abuse/repository";
import { ArtifactsEntity, SubmissionsEntity } from "./db/entities";
import { useTemporaryDatabase } from "./db/test_helpers";
import { retryFailedWebsiteAnalysis, websiteSubmissionDedupeKey } from "./submissions/website";
import { capturedDocumentContent, WebsiteCaptureFailedError, WebsiteUnreachableError, type ArchiveWebsiteOptions, type WebsiteArchiveResult, type WebsitePageSession } from "./website_archive";
import { analyzeWebsite, buildWebsiteClassificationInput, buildWebsiteReportEvidence, continuedNavigation, websiteContinuation, type WebsiteAnalysisDependencies } from "./website_ai";
import { extractWebsiteContinuationControls, extractWebsiteContinuationLinks } from "./website_fields";
import type { WebsiteNavigationHop, WebsitePageAction, WebsitePerformedAction } from "./website_types";

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
	[CONSENT]: { finding: "insufficient_evidence", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], continuationRef: "l1", hiddenFrameRef: "", mobileHandoff: false },
	[GET_STARTED]: { finding: "insufficient_evidence", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], continuationRef: "L1 ", hiddenFrameRef: "", mobileHandoff: false },
	[RECOVERY]: {
		finding: "phishing",
		phishingBasis: "credential_theft",
		evidenceQuote: "Access your wallet with your Secret Recovery Phrase",
		collectionFieldRefs: ["f2", "f3"],
		continuationRef: "", hiddenFrameRef: "", mobileHandoff: false,
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

async function waitForStatus(id: bigint, statuses: string[]) {
	for (let attempt = 0; attempt < 200; attempt++) {
		const submission = await SubmissionsEntity.get(id);
		if (submission && statuses.includes(submission.status)) return submission;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Submission ${id} did not reach ${statuses.join("/")}.`);
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
		expect(websiteContinuation({ continuationRef: " L1" }, html, CONSENT)).toEqual({ kind: "link", link: { ref: "l1", label: "I agree", url: GET_STARTED } });
		// The privacy link goes to another site and is never a step of the kit's flow.
		expect(websiteContinuation({ continuationRef: "l2" }, html, CONSENT)).toBeUndefined();
		expect(websiteContinuation({ continuationRef: "" }, html, CONSENT)).toBeUndefined();
		expect(websiteContinuation({}, html, CONSENT)).toBeUndefined();
	});

	test("a followed page records the link that opened it and how the visitor got there", () => {
		const consent = liveCapture(CONSENT);
		const next = liveCapture(GET_STARTED);
		const hops = continuedNavigation(consent.navigationHops, consent.navigationHops[0]!, { redirectTo: GET_STARTED, followedLink: { label: "I agree" } }, next.navigationHops);
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
			{ navigationHops: [...hops.slice(0, 1), { ...hops[1]!, contentCaptured: false, redirectTo: RECOVERY, followedLink: { label: "Import an existing wallet" } }, { index: 2, url: RECOVERY, hostname: new URL(SITE).hostname, status: 200, contentCaptured: true }] },
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
		const unconfirmed = { ...KIT_ANSWERS, [RECOVERY]: { finding: "insufficient_evidence", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], continuationRef: "", hiddenFrameRef: "", mobileHandoff: false } };
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

	test("a link whose page ends on another site hands that site to its own case, as a redirect would", async () => {
		const id = await websiteSubmission(375914181917937693n, CONSENT);
		const elsewhere = "https://wallet-restore.example.net/";
		PAGES[elsewhere] = "<html><body><h1>Restore</h1></body></html>";
		const captures: ArchiveWebsiteOptions[] = [];

		await analyzeWebsite({ submissionId: id, url: CONSENT }, dependencies({
			captures,
			answers: { ...KIT_ANSWERS, [elsewhere]: { ...KIT_ANSWERS[CONSENT]!, continuationRef: "" } },
			capture: (options) => options.url === GET_STARTED
				? liveCapture(options.url, [
					{ index: 0, url: GET_STARTED, hostname: new URL(SITE).hostname, status: 302, redirectTo: elsewhere, contentCaptured: false },
					{ index: 1, url: elsewhere, hostname: "wallet-restore.example.net", status: 200, contentCaptured: true },
				])
				: liveCapture(options.url),
		}));

		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("redirected");
		expect(submission?.info).toBe(`${CONSENT} sends visitors on to wallet-restore.example.net through its link "I agree" to ${GET_STARTED}; that site is analyzed and reported in its own case.`);
		expect(websiteData(submission)?.navigationHops?.map(({ url, status, followedLink }) => ({ url, status, followed: followedLink?.label }))).toEqual([
			{ url: CONSENT, status: 200, followed: "I agree" },
			{ url: GET_STARTED, status: 302, followed: undefined },
			{ url: elsewhere, status: 200, followed: undefined },
		]);
		const child = await waitForStatus(BigInt(websiteData(submission)!.redirectSubmissionId!), ["reported", "failed", "invalid"]);
		expect(child.source).toBe(`redirect:${id}`);
		expect(websiteData(child)?.navigationHops?.map(({ url }) => url)).toEqual([elsewhere]);
		// The destination's case analyzes the page the link reached; it does not load it again.
		expect(captures.filter(({ url }) => url === elsewhere)).toEqual([expect.objectContaining({ archivedUrl: elsewhere, mhtmlSnapshot: expect.any(Buffer) })]);
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
		const endless: ClassifierAnswers = Object.fromEntries(pages.map((page) => [page, { finding: "insufficient_evidence", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], continuationRef: "l1", hiddenFrameRef: "", mobileHandoff: false }]));
		const endlessCaptures: ArchiveWebsiteOptions[] = [];
		const endlessId = await websiteSubmission(375914181917937695n, pages[0]!);
		await analyzeWebsite({ submissionId: endlessId, url: pages[0]! }, dependencies({ answers: endless, captures: endlessCaptures }));
		expect(endlessCaptures.map(({ url }) => url)).toEqual(pages.slice(0, 4));
		const endlessCase = await SubmissionsEntity.get(endlessId);
		expect(endlessCase?.status).toBe("invalid");
		expect(endlessCase?.info).toEndWith(`its link "Next" to ${pages[4]} was not followed after 3 steps.`);
	});
});

/**
 * The DocuSign email gate of submission 376813288618463354, as the residential
 * exit captured it: honeypot fields, the email field, a Turnstile widget, and
 * an "Open" button. Submitting it opens the kit's sign-in page.
 */
const GATE_SITE = "https://docusign.alt3-doc3ea7-v2.sbs";
const GATE = `${GATE_SITE}/word/verify.workspace.php`;
const SIGN_IN = `${GATE_SITE}/word/signin.php`;
PAGES[GATE] = `<html lang="en"><head><title>Verify Your Email</title></head><body>
<div class="card"><h1>Verify Your Email</h1>
<form action="${GATE}" method="POST" novalidate autocomplete="off" id="mainForm">
<label for="email">Email address</label>
<input type="text" name="website" class="hp-field" tabindex="-1" autocomplete="off" aria-hidden="true">
<input type="text" name="company_url" class="hp-field" tabindex="-1" autocomplete="off" aria-hidden="true">
<input type="text" name="fax_number" class="hp-field" tabindex="-1" autocomplete="off" aria-hidden="true">
<input type="text" name="address_line2" class="hp-field" tabindex="-1" autocomplete="off" aria-hidden="true">
<input type="email" id="email" name="email" placeholder="you@example.com" autocomplete="email" required>
<div class="cf-turnstile" data-sitekey="0x4AAAAAADg6vRuzsW0g74ZR"></div>
<button type="submit" id="submitBtn">Open</button>
</form></div></body></html>`;
PAGES[SIGN_IN] = `<html lang="en"><head><title>Sign in to your account</title></head><body>
<div class="card"><img alt="Microsoft"><div id="identity">probe@example.invalid</div><h1>Enter password</h1>
<form action="${GATE_SITE}/word/next.php" method="POST"><input type="password" name="passwd" placeholder="Password"><button type="submit">Sign in</button></form>
</div></body></html>`;

const GATE_ANSWERS: ClassifierAnswers = {
	[GATE]: { finding: "insufficient_evidence", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], continuationRef: "f5", hiddenFrameRef: "", mobileHandoff: false },
	[SIGN_IN]: { finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "Enter password", collectionFieldRefs: ["f1"], continuationRef: "", hiddenFrameRef: "", mobileHandoff: false },
};

const EMAIL_FIELD = { ref: "f5", control: "input[type=email]", id: "email", name: "email", autocomplete: "email", label: "Email address", placeholder: "you@example.com" };

/**
 * A live visit whose browser stays open: `pages` answers each action with what
 * the page then shows (by the action and how many were taken before it), and
 * the session records every action and whether it was closed.
 */
function liveVisit(first: WebsiteArchiveResult, pages: (action: WebsitePageAction, taken: number) => WebsiteArchiveResult | Error) {
	const actions: WebsitePageAction[] = [];
	const visit = { actions, closed: 0, archive: undefined as unknown as WebsiteArchiveResult };
	const session: WebsitePageSession = {
		act: async (action) => {
			if (visit.closed) throw new Error("act on a closed session");
			const page = pages(action, actions.length);
			actions.push(action);
			if (page instanceof Error) throw page;
			return page;
		},
		close: async () => { visit.closed++; },
	};
	visit.archive = { ...first, session };
	return visit;
}

const RESIDENTIAL = { route: "residential exit" } as const;
const hopsTo = (url: string, from?: { url: string; status: number }) => from
	? [{ index: 0, url: from.url, hostname: new URL(from.url).hostname, status: from.status, redirectTo: url, contentCaptured: false }, { index: 1, url, hostname: new URL(url).hostname, status: 200, contentType: "text/html", contentCaptured: true }]
	: [{ index: 0, url, hostname: new URL(url).hostname, status: 200, contentType: "text/html", contentCaptured: true }];
const performed = (action: WebsitePageAction, humanCheck?: "passed" | "unsolved") => (action.kind === "fill" && humanCheck ? { ...action, humanCheck } : action) as WebsitePerformedAction;

describe("actions on a kit's own pages", () => {
	test("only an identifier field the page can find again, on a page without a password field, can be submitted", () => {
		const gateHtml = capturedDocumentContent(PAGES[GATE]!).html;
		expect(websiteContinuation({ continuationRef: "F5" }, gateHtml, GATE)).toEqual({ kind: "field", field: EMAIL_FIELD });
		// Unknown refs, and a field with neither id nor name, name nothing.
		expect(websiteContinuation({ continuationRef: "f9" }, gateHtml, GATE)).toBeUndefined();
		expect(websiteContinuation({ continuationRef: "f1" }, `<input type="email" placeholder="Email">`, GATE)).toBeUndefined();
		// A password field is never filled, and a page that asks for one shows its harmful step itself.
		const signInHtml = capturedDocumentContent(PAGES[SIGN_IN]!).html;
		expect(websiteContinuation({ continuationRef: "f1" }, signInHtml, SIGN_IN)).toBeUndefined();
		expect(websiteContinuation({ continuationRef: "f1" }, `<input type="email" name="email"><input type="password" name="pw">`, GATE)).toBeUndefined();
		// Only typed identifiers: no selects, text areas, or numbers.
		expect(websiteContinuation({ continuationRef: "f1" }, `<select name="country"><option>DE</option></select>`, GATE)).toBeUndefined();
		expect(websiteContinuation({ continuationRef: "f1" }, `<textarea name="message"></textarea>`, GATE)).toBeUndefined();
		expect(websiteContinuation({ continuationRef: "f1" }, `<input type="number" name="amount">`, GATE)).toBeUndefined();
		expect(websiteContinuation({ continuationRef: "f1" }, `<input type="tel" name="phone">`, GATE)).toMatchObject({ kind: "field", field: { name: "phone" } });
	});

	test("a kit's buttons are listed once per caption, never disabled, hidden, or captionless ones", () => {
		const html = `<div class="card"><h1>One more step</h1><button type="button" id="x1"><span></span><span>Confirm</span></button>
<button>Confirm</button><button disabled>Continue</button><button aria-hidden="true">Skip</button><button><svg/></button>
<input type="submit" value="View document"><div role="button" aria-label="Open file"></div><a href="/next">Next</a></div>`;
		expect(extractWebsiteContinuationControls(html)).toEqual([
			{ ref: "b1", label: "Confirm" },
			{ ref: "b2", label: "View document" },
			{ ref: "b3", label: "Open file" },
		]);
		expect(websiteContinuation({ continuationRef: "B1" }, html, GATE)).toEqual({ kind: "click", control: { ref: "b1", label: "Confirm" } });
		expect(websiteContinuation({ continuationRef: "b9" }, html, GATE)).toBeUndefined();
		// Links keep their own refs; a link ref never names a button.
		expect(websiteContinuation({ continuationRef: "l1" }, html, GATE)).toMatchObject({ kind: "link" });
	});

	test("the DocuSign email gate is submitted with a canary in the same visit, and its sign-in page is reported", async () => {
		const captures: ArchiveWebsiteOptions[] = [];
		const modelCalls: Array<{ kind: "classification" | "analysis"; url: string }> = [];
		const visit = liveVisit({ ...liveCapture(GATE), ...RESIDENTIAL }, (action) => ({
			...liveCapture(GATE, hopsTo(SIGN_IN, { url: GATE, status: 302 })),
			...RESIDENTIAL,
			performedAction: performed(action, "passed"),
		}));
		const id = await websiteSubmission(376813288618463354n, GATE);

		await analyzeWebsite({ submissionId: id, url: GATE }, dependencies({ answers: GATE_ANSWERS, captures, modelCalls, capture: () => visit.archive }));

		// One live capture; the email is submitted on its page, and only the email
		// field is filled, with a value that reaches no one.
		expect(captures).toEqual([expect.objectContaining({ url: GATE, keepSession: true })]);
		expect(visit.actions).toEqual([{ kind: "fill", field: EMAIL_FIELD, value: expect.stringMatching(/^probe\.[0-9a-f]{16}@probe-canary\.invalid$/) }]);
		const value = (visit.actions[0] as { value: string }).value;
		// The browser is released once the flow is done, before the narrative and the report.
		expect(visit.closed).toBeGreaterThanOrEqual(1);
		expect(modelCalls).toEqual([
			{ kind: "classification", url: GATE },
			{ kind: "classification", url: SIGN_IN },
			{ kind: "analysis", url: SIGN_IN },
		]);

		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("reported");
		const website = websiteData(submission);
		expect(website?.archiveUrl).toBe(SIGN_IN);
		expect(website?.navigationHops).toEqual([
			{ index: 0, url: GATE, hostname: new URL(GATE).hostname, status: 200, contentType: "text/html", redirectTo: GATE, performedAction: { kind: "fill", field: EMAIL_FIELD, value, humanCheck: "passed" }, contentCaptured: false },
			{ index: 1, url: GATE, hostname: new URL(GATE).hostname, status: 302, redirectTo: SIGN_IN, contentCaptured: false },
			{ index: 2, url: SIGN_IN, hostname: new URL(GATE).hostname, status: 200, contentType: "text/html", contentCaptured: true },
		]);
		expect(website?.siteAssessments?.map(({ hopIndex, finding }) => ({ hopIndex, finding }))).toEqual([
			{ hopIndex: 0, finding: "phishing" },
			{ hopIndex: 1, finding: "phishing" },
			{ hopIndex: 2, finding: "phishing" },
		]);

		// The sign-in page is classified knowing how it was reached and whose value it shows.
		const input = buildWebsiteClassificationInput(website!.navigationHops![2]!, { ...liveCapture(SIGN_IN), navigationHops: website!.navigationHops! });
		const text = (input[1]!.content as Array<{ text?: string }>)[0]!.text!;
		expect(text).toContain(`The visitor reaches this page by entering their details into the field "Email address" on ${GATE}, an earlier page of the same site, and submitting it. The capture entered the made-up value "${value}"; wherever this page shows that value, it is the capture's, not a real visitor's.`);
		expect(text).not.toContain("captcha beside that field had not passed");

		// The email page is its own evidence step.
		expect((await ArtifactsEntity.listForSubmission(id)).map(({ name }) => name).sort()).toEqual([
			"evidence-manifest.json",
			"evidence-step2-manifest.json",
			"website-stamped.png",
			"website-step2-stamped.png",
			"website-step2.mhtml",
			"website-step2.png",
			"website.mhtml",
			"website.png",
		]);
		const report = await AbuseRepository.getReportForSubmission(id);
		expect(report!.description).toContain(`Visitors reach the page through the site's own earlier pages: submitting the field "Email address" on ${GATE}.`);
		// The canary is ours; it never goes into a provider's report.
		expect(report!.description).not.toContain(value);
	});

	test("the kit's \"One more step\" button is clicked, then its email page submitted, all in one visit", async () => {
		const INTERSTITIAL_URL = `${GATE_SITE}/bddd57b086e6`;
		PAGES[INTERSTITIAL_URL] = `<html><head><title>One more step</title></head><body><div>Protected session</div><h1>One more step</h1>
<p>One click verifies your session and lets you continue.</p><button type="button" id="fsjrdbmpp03a"><span>Confirm</span></button>
<input type="text" name="website" tabindex="-1" aria-hidden="true"></body></html>`;
		const answers: ClassifierAnswers = {
			[INTERSTITIAL_URL]: { finding: "insufficient_evidence", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], continuationRef: "b1", hiddenFrameRef: "", mobileHandoff: false },
			...GATE_ANSWERS,
		};
		const captures: ArchiveWebsiteOptions[] = [];
		const modelCalls: Array<{ kind: "classification" | "analysis"; url: string }> = [];
		// The submitted URL's self-posting step lands on the interstitial.
		const visit = liveVisit({ ...liveCapture(INTERSTITIAL_URL, hopsTo(INTERSTITIAL_URL, { url: GATE, status: 302 })), requestedUrl: GATE, ...RESIDENTIAL }, (action, taken) => (taken === 0
			? { ...liveCapture(GATE, hopsTo(GATE)), requestedUrl: GATE, ...RESIDENTIAL, performedAction: performed(action) }
			: { ...liveCapture(SIGN_IN, hopsTo(SIGN_IN, { url: GATE, status: 302 })), requestedUrl: GATE, ...RESIDENTIAL, performedAction: performed(action, "passed") }));
		const id = await websiteSubmission(376813288618463359n, GATE);

		await analyzeWebsite({ submissionId: id, url: GATE }, dependencies({ answers, captures, modelCalls, capture: () => visit.archive }));

		expect(captures).toHaveLength(1);
		expect(visit.actions.map((action) => action.kind)).toEqual(["click", "fill"]);
		expect(visit.actions[0]).toEqual({ kind: "click", control: { ref: "b1", label: "Confirm" } });
		expect(modelCalls.map(({ url }) => url)).toEqual([INTERSTITIAL_URL, GATE, SIGN_IN, SIGN_IN]);

		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("reported");
		const website = websiteData(submission);
		expect(website?.navigationHops?.map(({ url, status, performedAction, contentCaptured }) => ({ url, status, action: performedAction?.kind, contentCaptured }))).toEqual([
			{ url: GATE, status: 302, action: undefined, contentCaptured: false },
			{ url: INTERSTITIAL_URL, status: 200, action: "click", contentCaptured: false },
			{ url: GATE, status: 200, action: "fill", contentCaptured: false },
			{ url: GATE, status: 302, action: undefined, contentCaptured: false },
			{ url: SIGN_IN, status: 200, action: undefined, contentCaptured: true },
		]);
		// The email page, as it was classified: reached by the click before it.
		const emailPageHops = website!.navigationHops!.slice(0, 3).map((hop, index) => (index === 2 ? { ...hop, performedAction: undefined, contentCaptured: true } : hop));
		const input = buildWebsiteClassificationInput(emailPageHops[2]!, { ...liveCapture(GATE), navigationHops: emailPageHops });
		expect((input[1]!.content as Array<{ text?: string }>)[0]!.text!).toContain(`The visitor reaches this page by clicking the button "Confirm" on ${INTERSTITIAL_URL}, an earlier page of the same site.`);
		const report = await AbuseRepository.getReportForSubmission(id);
		expect(report!.description).toContain(`Visitors reach the page through the site's own earlier pages: clicking the button "Confirm" on ${INTERSTITIAL_URL}, then submitting the field "Email address" on ${GATE}.`);
	});

	test("a submission whose captcha never passed and that changed nothing stops the flow and says so", async () => {
		const id = await websiteSubmission(376813288618463355n, GATE);
		const visit = liveVisit({ ...liveCapture(GATE), ...RESIDENTIAL }, (action) => ({ ...liveCapture(GATE), ...RESIDENTIAL, performedAction: performed(action, "unsolved") }));

		await analyzeWebsite({ submissionId: id, url: GATE }, dependencies({ answers: GATE_ANSWERS, captures: [], capture: () => visit.archive }));

		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("invalid");
		expect(submission?.info).toEndWith(`The capture stopped following the site's flow: its field "Email address" changed nothing on the page; the captcha beside it never passed.`);
		expect(websiteData(submission)?.navigationHops).toHaveLength(1);
		expect(visit.closed).toBeGreaterThanOrEqual(1);
	});

	test("a page that asks for the same field again after its submission is not submitted twice", async () => {
		const id = await websiteSubmission(376813288618463358n, GATE);
		const rejected = capturedDocumentContent(PAGES[GATE]!.replace("<h1>Verify Your Email</h1>", "<h1>Verify Your Email</h1><p>This address is not allowed.</p>"));
		const visit = liveVisit({ ...liveCapture(GATE), ...RESIDENTIAL }, (action) => ({
			...liveCapture(GATE),
			...RESIDENTIAL,
			html: Buffer.from(rejected.html),
			text: Buffer.from(rejected.text),
			performedAction: performed(action, "passed"),
		}));

		await analyzeWebsite({ submissionId: id, url: GATE }, dependencies({ answers: GATE_ANSWERS, captures: [], capture: () => visit.archive }));

		expect(visit.actions).toHaveLength(1);
		const submission = await SubmissionsEntity.get(id);
		expect(submission?.info).toEndWith(`its field "Email address" was already submitted on the way to this page.`);
		expect(websiteData(submission)?.navigationHops?.map(({ url, performedAction, contentCaptured }) => ({ url, submitted: Boolean(performedAction), contentCaptured }))).toEqual([
			{ url: GATE, submitted: true, contentCaptured: false },
			{ url: GATE, submitted: false, contentCaptured: true },
		]);
	});

	test("a field the live page does not show stops the flow with the reason", async () => {
		const id = await websiteSubmission(376813288618463356n, GATE);
		const missing = new WebsiteCaptureFailedError([new WebsiteUnreachableError("residential", `the page showed no field "Email address" to enter the value into`)]);
		const visit = liveVisit({ ...liveCapture(GATE), ...RESIDENTIAL }, () => missing);

		await analyzeWebsite({ submissionId: id, url: GATE }, dependencies({ answers: GATE_ANSWERS, captures: [], capture: () => visit.archive }));

		expect((await SubmissionsEntity.get(id))?.info).toEndWith(`its field "Email address" could not be submitted (${missing.message}).`);
		expect(visit.closed).toBeGreaterThanOrEqual(1);
	});

	test("a page from a stored capture is loaded live before the action, from the page that linked to it", async () => {
		const id = await websiteSubmission(376813288618463360n, GATE);
		const captures: ArchiveWebsiteOptions[] = [];
		const visit = liveVisit({ ...liveCapture(GATE), ...RESIDENTIAL }, (action) => ({ ...liveCapture(SIGN_IN, hopsTo(SIGN_IN, { url: GATE, status: 302 })), ...RESIDENTIAL, performedAction: performed(action, "passed") }));

		await analyzeWebsite({ submissionId: id, url: GATE }, dependencies({
			answers: GATE_ANSWERS,
			captures,
			// The first capture is a stored MHTML: it has no open browser.
			capture: (options) => (captures.length === 1 ? { ...liveCapture(GATE), ...RESIDENTIAL } : visit.archive),
		}));

		expect(captures.map(({ url }) => url)).toEqual([GATE, GATE]);
		expect(visit.actions.map((action) => action.kind)).toEqual(["fill"]);
		expect((await SubmissionsEntity.get(id))?.status).toBe("reported");
	});

	test("a second identifier step is taken on the page the first one opened", async () => {
		const PHONE = `${GATE_SITE}/word/phone.php`;
		PAGES[PHONE] = `<html><body><h1>Confirm your phone</h1><form method="POST"><input type="tel" id="phone" name="phone"><button>Next</button></form></body></html>`;
		const answers: ClassifierAnswers = {
			[GATE]: GATE_ANSWERS[GATE]!,
			[PHONE]: { finding: "insufficient_evidence", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], continuationRef: "f1", hiddenFrameRef: "", mobileHandoff: false },
			[SIGN_IN]: { ...GATE_ANSWERS[SIGN_IN]!, finding: "insufficient_evidence", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [] },
		};
		const visit = liveVisit({ ...liveCapture(GATE), ...RESIDENTIAL }, (action, taken) => ({
			...liveCapture(taken === 0 ? PHONE : SIGN_IN, hopsTo(taken === 0 ? PHONE : SIGN_IN)),
			...RESIDENTIAL,
			performedAction: performed(action),
		}));
		const id = await websiteSubmission(376813288618463357n, GATE);

		await analyzeWebsite({ submissionId: id, url: GATE }, dependencies({ answers, captures: [], capture: () => visit.archive }));

		expect(visit.actions.map((action) => (action.kind === "fill" ? { name: action.field.name, value: action.value } : action))).toEqual([
			{ name: "email", value: expect.stringMatching(/@probe-canary\.invalid$/) },
			{ name: "phone", value: expect.stringMatching(/^\+12125550[01]\d\d$/) },
		]);
		const hops = websiteData(await SubmissionsEntity.get(id))?.navigationHops;
		expect(hops?.map(({ url, performedAction }) => ({ url, field: performedAction?.kind === "fill" ? performedAction.field.name : undefined }))).toEqual([
			{ url: GATE, field: "email" },
			{ url: PHONE, field: "phone" },
			{ url: SIGN_IN, field: undefined },
		]);
	});

	test("a session gate whose button sends the visitor to the kit's own domain hands that domain to its own case, which is reported", async () => {
		// Submission 379232259422556174: a shortener answers with a "Verify this
		// session" page; its "Continue" button opens the kit on another domain.
		const SHORT = "https://encurtador09ea.com/sa";
		const SESSION_GATE = "https://encurtador09ea.com/e4d5b3c9a66e";
		const KIT = "https://en-web09.pw/login";
		PAGES[SESSION_GATE] = `<html><head><title>Verify this session</title></head><body><main><h1>Verify this session</h1>
<p>Press continue to open the page.</p><button type="button" id="go">Continue</button></main></body></html>`;
		PAGES[KIT] = `<html><head><title>Sign in</title></head><body><img alt="Microsoft"><h1>Sign in</h1>
<form method="POST"><input type="email" name="login" placeholder="Email"><input type="password" name="passwd" placeholder="Password"><button>Sign in</button></form></body></html>`;
		const answers: ClassifierAnswers = {
			[SESSION_GATE]: { finding: "insufficient_evidence", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], continuationRef: "b1", hiddenFrameRef: "", mobileHandoff: false },
			[KIT]: { finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "Sign in", collectionFieldRefs: ["f1", "f2"], continuationRef: "", hiddenFrameRef: "", mobileHandoff: false },
		};
		const captures: ArchiveWebsiteOptions[] = [];
		const visit = liveVisit({ ...liveCapture(SESSION_GATE, hopsTo(SESSION_GATE, { url: SHORT, status: 302 })), requestedUrl: SHORT, ...RESIDENTIAL }, (action) => ({
			...liveCapture(KIT, hopsTo(KIT)),
			requestedUrl: SHORT,
			...RESIDENTIAL,
			performedAction: performed(action),
		}));
		const id = await websiteSubmission(379232259422556174n, SHORT);

		await analyzeWebsite({ submissionId: id, url: SHORT }, dependencies({
			answers,
			captures,
			capture: (options) => (options.url === SHORT ? visit.archive : { ...liveCapture(options.url), ...RESIDENTIAL }),
		}));

		expect(visit.actions).toEqual([{ kind: "click", control: { ref: "b1", label: "Continue" } }]);
		expect(visit.closed).toBeGreaterThanOrEqual(1);
		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("redirected");
		expect(submission?.info).toBe(`${SHORT} sends visitors on to en-web09.pw through its button "Continue"; that site is analyzed and reported in its own case.`);
		expect(websiteData(submission)?.navigationHops?.map(({ url, status, performedAction, contentCaptured }) => ({ url, status, action: performedAction?.kind, contentCaptured }))).toEqual([
			{ url: SHORT, status: 302, action: undefined, contentCaptured: false },
			{ url: SESSION_GATE, status: 200, action: "click", contentCaptured: false },
			{ url: KIT, status: 200, action: undefined, contentCaptured: true },
		]);
		expect(await AbuseRepository.getReportForSubmission(id)).toBeUndefined();

		const child = await waitForStatus(BigInt(websiteData(submission)!.redirectSubmissionId!), ["reported", "failed", "invalid"]);
		expect(child.status).toBe("reported");
		expect(websiteData(child)?.url).toBe(KIT);
		expect(websiteData(child)?.navigationHops?.map(({ index, url }) => ({ index, url }))).toEqual([{ index: 0, url: KIT }]);
		expect((await AbuseRepository.getReportForSubmission(child.id))?.description).toContain('"Sign in"');
	});

	test("a followed link releases the page it leaves before loading the next one", async () => {
		const id = await websiteSubmission(375914181917937696n, CONSENT);
		const visits = [CONSENT, GET_STARTED, RECOVERY].map((page) => liveVisit(liveCapture(page), () => new Error("no action expected")));

		await analyzeWebsite({ submissionId: id, url: CONSENT }, dependencies({ captures: [], capture: (options) => visits.find((visit) => visit.archive.url === options.url)!.archive }));

		expect((await SubmissionsEntity.get(id))?.status).toBe("reported");
		expect(visits.map((visit) => visit.closed > 0)).toEqual([true, true, true]);
	});
});
