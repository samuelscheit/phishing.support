import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import type { AnalysisClient } from "./analysis_run";
import { AbuseRepository } from "./abuse/repository";
import { ArtifactsEntity } from "./db/entities/artifacts";
import { SubmissionsEntity } from "./db/entities/submissions";
import { useTemporaryDatabase } from "./db/test_helpers";
import { retryFailedWebsiteAnalysis, websiteSubmissionDedupeKey } from "./submissions/website";
import { capturedDocumentContent } from "./website_archive/text";
import type { ArchiveWebsiteOptions, WebsiteArchiveResult, WebsitePageSession } from "./website_archive/types";
import { analyzeWebsite, type WebsiteAnalysisDependencies } from "./website_ai";
import { buildWebsiteClassificationInput } from "./website_classification";
import { getDb } from "./db";
import { abuseJobs, abuseArtifacts } from "./abuse/schema";
import { readInvestigationJobPayload } from "./investigation/payload";
import { scriptedVisitSession, type ScriptedVisit } from "./site_visit/test_helpers";
import { reporterBrowserIdentity } from "./browser/reporter_identity";
import type { WebsiteNavigationHop } from "./website_types";
import { eq } from "drizzle-orm";

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
	[CONSENT]: { finding: "insufficient_evidence", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], hiddenFrameRef: "", mobileHandoff: false },
	[GET_STARTED]: { finding: "insufficient_evidence", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], hiddenFrameRef: "", mobileHandoff: false },
	[RECOVERY]: {
		finding: "phishing",
		phishingBasis: "credential_theft",
		evidenceQuote: "Access your wallet with your Secret Recovery Phrase",
		collectionFieldRefs: ["f2", "f3"],
		hiddenFrameRef: "", mobileHandoff: false,
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
					: prompt.match(/The analyzed page is (\S+?):\\n/)![1]!;
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

/** The visit's session for the page: it plays `visit`, and records whether it was closed. */
function visited(page: WebsiteArchiveResult, visit: ScriptedVisit = {}) {
	const state = { closed: 0 };
	const scripted = scriptedVisitSession(visit);
	const session: WebsitePageSession = { visit: scripted.visit, close: async () => { state.closed++; } };
	return { archive: { ...page, session }, state };
}

function dependencies(params: {
	answers?: ClassifierAnswers;
	captures: ArchiveWebsiteOptions[];
	modelCalls?: Array<{ kind: "classification" | "analysis"; url: string }>;
	/** The capture of each requested page, with the visit it plays. */
	capture?: (options: ArchiveWebsiteOptions) => WebsiteArchiveResult;
}): WebsiteAnalysisDependencies {
	return {
		getInfo: async () => ({ ip_rdaps: [] }),
		analysisClient: kitModel(params.answers ?? KIT_ANSWERS, params.modelCalls),
		domainRegistration: async () => undefined,
		timestampEvidence: async () => undefined,
		browserBackoffMs: [1],
		downloadLookups: async () => [],
		archiveWebsite: async (options) => {
			params.captures.push(options);
			return params.capture ? params.capture(options) : visited(liveCapture(options.url)).archive;
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
	[GATE]: { finding: "insufficient_evidence", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], hiddenFrameRef: "", mobileHandoff: false },
	[SIGN_IN]: { finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "Enter password", collectionFieldRefs: ["f1"], hiddenFrameRef: "", mobileHandoff: false, impersonatedBrand: "Microsoft", brandOfficialUrl: "https://www.microsoft.com" },
};


const RESIDENTIAL = { route: "residential exit" } as const;
const hopsTo = (url: string, from?: { url: string; status: number }) => from
	? [{ index: 0, url: from.url, hostname: new URL(from.url).hostname, status: from.status, redirectTo: url, contentCaptured: false }, { index: 1, url, hostname: new URL(url).hostname, status: 200, contentType: "text/html", contentCaptured: true }]
	: [{ index: 0, url, hostname: new URL(url).hostname, status: 200, contentType: "text/html", contentCaptured: true }];

/** The MetaMask kit's visit: the agent agrees, gets started, and reaches the recovery form. */
const METAMASK_VISIT: ScriptedVisit = { steps: [liveCapture(GET_STARTED), liveCapture(RECOVERY)] };

describe("a visit through a multi-page kit", () => {
	test("the MetaMask kit is walked from its consent page to the recovery-phrase form and reported with every page", async () => {
		const captures: ArchiveWebsiteOptions[] = [];
		const modelCalls: Array<{ kind: "classification" | "analysis"; url: string }> = [];
		const id = await websiteSubmission(375914181917937690n, CONSENT);
		const reporterUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
		// Every page of the visit is a snapshot of the one browser, which presents the reporter's.
		const asReporter = (page: WebsiteArchiveResult) => ({ ...page, userAgent: reporterUserAgent });
		const visit = visited(asReporter(liveCapture(CONSENT)), { steps: METAMASK_VISIT.steps!.map(asReporter) });

		await analyzeWebsite({ submissionId: id, url: CONSENT, reporterHeaders: { "user-agent": reporterUserAgent } }, dependencies({ captures, modelCalls, capture: () => visit.archive }));

		// One capture; the agent walks the rest of the site in its browser, which is released.
		expect(captures.map(({ url }) => url)).toEqual([CONSENT]);
		expect(visit.state.closed).toBeGreaterThanOrEqual(1);
		// The pages are judged in the order shown until the first reportable one; the narrative describes it.
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
		expect(website?.navigationHops?.map(({ index, url, redirectTo, visitorStep, contentCaptured }) => ({ index, url, redirectTo, visitorStep, contentCaptured }))).toEqual([
			{ index: 0, url: CONSENT, redirectTo: GET_STARTED, visitorStep: { submitted: [] }, contentCaptured: false },
			{ index: 1, url: GET_STARTED, redirectTo: RECOVERY, visitorStep: { submitted: [] }, contentCaptured: false },
			{ index: 2, url: RECOVERY, redirectTo: undefined, visitorStep: undefined, contentCaptured: true },
		]);
		// Each page keeps its own finding.
		expect(website?.siteAssessments?.map(({ hopIndex, finding }) => ({ hopIndex, finding }))).toEqual([
			{ hopIndex: 0, finding: "insufficient_evidence" },
			{ hopIndex: 1, finding: "insufficient_evidence" },
			{ hopIndex: 2, finding: "phishing" },
		]);
		expect(website?.siteAssessments?.[2]).toMatchObject({
			phishingBasis: "credential_theft",
			evidenceQuote: "Access your wallet with your Secret Recovery Phrase",
			collectionFields: [{ ref: "f2", name: "word1" }, { ref: "f3", name: "word2" }],
		});
		expect(website?.visit).toMatchObject({ outcome: "completed" });
		// The kit files of every page are kept for sibling discovery, once per hash.
		expect(website?.kitResources?.map(({ sha256 }) => sha256)).toEqual(["a".repeat(64), "b".repeat(64)]);

		// Every page is evidence with its own stamped screenshot and manifest.
		const artifacts = await ArtifactsEntity.listForSubmission(id);
		expect(artifacts.map(({ name }) => name).sort()).toEqual([
			"evidence-manifest.json",
			"evidence-step2-manifest.json",
			"evidence-step3-manifest.json",
			// The visit itself is evidence: its record, the readable chronology and their manifest.
			"visit-manifest.json",
			"visit-protocol.txt",
			"visit-record.json",
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
		expect(manifest.capture.navigation[1]).toMatchObject({ url: GET_STARTED, visitorStep: { submitted: [] } });

		// The report names all three pages, the form first, and shows each page.
		const report = await AbuseRepository.getReportForSubmission(id);
		const targets = await AbuseRepository.listTargets(report!.id);
		expect(targets.map(({ normalizedTarget, observedUrls }) => ({ normalizedTarget, observedUrls }))).toEqual([
			{ normalizedTarget: new URL(SITE).hostname, observedUrls: [RECOVERY, CONSENT, GET_STARTED] },
		]);
		const input = await AbuseRepository.getReportInput(report!.id);
		expect(input?.evidenceArtifacts.map(({ name }) => name)).toEqual(["website-step3.png", "website.png", "website-step2.png"]);
		expect(report!.description).toContain(`Visitors reach the page through the site's own earlier pages: ${CONSENT}, then ${GET_STARTED}.`);
		// A reviewer gets the browser the capture presented: Cloudflare's form takes it as its own field.
		expect(report!.reportedUserAgent).toBe(reporterUserAgent);
		expect(report!.description).toContain(`It was captured with the browser of the person who reported it, User-Agent "${reporterUserAgent}"`);
	});

	test("the DocuSign gate takes the visit's made-up email, and its sign-in page sends the made-up password to a Telegram bot: reported with that data drop", async () => {
		const modelCalls: Array<{ kind: "classification" | "analysis"; url: string }> = [];
		const id = await websiteSubmission(376813288618463354n, GATE);
		const bot = "https://api.telegram.org/bot8123456789:AAH-kit-token/sendMessage";
		const visit = visited({ ...liveCapture(GATE), ...RESIDENTIAL }, {
			steps: [{ ...liveCapture(GATE, hopsTo(SIGN_IN, { url: GATE, status: 302 })), ...RESIDENTIAL }],
			requests: (canaries) => [
				// The gate's form posts the email to the kit itself while the gate is shown…
				{ timestamp: "2026-11-15T10:00:00.500Z", url: GATE, method: "POST", postData: `email=${encodeURIComponent(canaries.email)}` },
				// …and the sign-in page's script posts the password to the kit's bot.
				{ timestamp: "2026-11-15T10:00:01.500Z", url: bot, method: "POST", postData: JSON.stringify({ chat_id: "-100777", text: `pass: ${canaries.password}` }) },
			],
			agent: { report: { asksForPhone: false, blockedByChallenge: false, stoppedReason: "The sign-in page showed an error after the password." } },
		});

		await analyzeWebsite({ submissionId: id, url: GATE }, dependencies({ answers: GATE_ANSWERS, captures: [], modelCalls, capture: () => visit.archive }));

		expect(modelCalls).toEqual([
			{ kind: "classification", url: GATE },
			{ kind: "classification", url: SIGN_IN },
			{ kind: "analysis", url: SIGN_IN },
		]);
		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("reported");
		const website = websiteData(submission);
		expect(website?.navigationHops).toEqual([
			{ index: 0, url: GATE, hostname: new URL(GATE).hostname, status: 200, contentType: "text/html", redirectTo: GATE, visitorStep: { submitted: ["email"] }, contentCaptured: false },
			{ index: 1, url: GATE, hostname: new URL(GATE).hostname, status: 302, redirectTo: SIGN_IN, contentCaptured: false },
			{ index: 2, url: SIGN_IN, hostname: new URL(GATE).hostname, status: 200, contentType: "text/html", contentCaptured: true },
		]);
		expect(website?.visit?.dataSent).toEqual([
			{ url: GATE, method: "POST", fields: ["email"], sameSite: true },
			{ url: bot, method: "POST", fields: ["password"], sameSite: false },
		]);

		// The sign-in page is classified knowing how it was reached and what it sent.
		const input = buildWebsiteClassificationInput(website!.navigationHops![2]!, {
			...liveCapture(SIGN_IN),
			navigationHops: website!.navigationHops!,
			dataSent: [{ url: bot, method: "POST", fields: ["password"], sameSite: false }],
		});
		const text = (input[1]!.content as Array<{ text?: string }>)[0]!.text!;
		expect(text).toContain(`The visitor reaches this page from ${GATE}, an earlier page of the same visit, after entering the synthetic email address there and submitting; wherever this page shows those values, they are the visit's, not a real visitor's.`);
		expect(text).toContain(`data_sent[1]:\n  - url: "${bot}"\n    method: POST\n    values[1]: password\n    same_site: false`);
		expect((input[0]!.content as string)).toContain("a page whose form sent the synthetic values it asked for to a messaging bot (api.telegram.org)");

		const report = await AbuseRepository.getReportForSubmission(id);
		expect(report!.description).toContain(`Visitors reach the page through the site's own earlier pages: ${GATE}, where our visit entered a synthetic email address and submitted.`);
		expect(report!.description).toContain(`In our visit with synthetic data, the site sent the entered password to ${bot} (POST).`);
		// Providers want the real brand named and linked.
		expect(report!.description).toContain("The page impersonates Microsoft and asks visitors for a password");
		expect(report!.description).toContain("Microsoft's official website is https://www.microsoft.com/; the reported site is not part of it.");
		expect(report!.legalBrandUrl).toBe("https://www.microsoft.com/");
		// The data drop is reported at its own host by the investigation, from the visit's own recording.
		const job = (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.reportId, report!.id)).get()!;
		expect(readInvestigationJobPayload(job.payload).dataDrops).toEqual([expect.objectContaining({ kind: "telegram_bot", key: "telegram-token:8123456789:AAH-kit-token", matchedCanaries: ["marker", "password"] })]);
		const capture = (await getDb()).select().from(abuseArtifacts).where(eq(abuseArtifacts.reportId, report!.id)).all().find((artifact) => artifact.name === "exfiltration-network-capture.json");
		expect(JSON.parse(Buffer.from(capture!.blob).toString("utf8"))).toMatchObject({ version: 2, pageUrl: SIGN_IN, backends: [expect.objectContaining({ kind: "telegram_bot" })] });

		// The visit is kept as evidence that holds up on its own: which values were made up,
		// every request that carried one with its full body, and the order of what happened.
		const files = await ArtifactsEntity.listForSubmission(id);
		const read = async (name: string) => Buffer.from((await ArtifactsEntity.get(files.find((file) => file.name === name)!.id))!.blob);
		const record = JSON.parse((await read("visit-record.json")).toString("utf8"));
		expect(record).toMatchObject({ version: 1, caseId: id.toString(), submittedUrl: GATE });
		expect(record.requests.map(({ url, carries }: { url: string; carries: string[] }) => ({ url, carries }))).toEqual([
			{ url: GATE, carries: ["email"] },
			{ url: bot, carries: ["password"] },
		]);
		expect(record.requests[1].postData).toContain(record.syntheticValues.password);
		const protocol = (await read("visit-protocol.txt")).toString("utf8");
		expect(protocol).toContain(`  password: ${record.syntheticValues.password}`);
		expect(protocol.indexOf(`Request POST ${GATE} carried the synthetic email address`)).toBeLessThan(protocol.indexOf(`Request POST ${bot} carried the synthetic password`));
		const manifest = JSON.parse((await read("visit-manifest.json")).toString("utf8"));
		const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
		expect(manifest.files).toEqual([
			{ name: "visit-record.json", sha256: sha(await read("visit-record.json")), size: (await read("visit-record.json")).byteLength },
			{ name: "visit-protocol.txt", sha256: sha(await read("visit-protocol.txt")), size: (await read("visit-protocol.txt")).byteLength },
		]);
	});

	test("a page that is already reportable ends the judging: later pages are not classified, but are kept as evidence", async () => {
		const modelCalls: Array<{ kind: "classification" | "analysis"; url: string }> = [];
		const id = await websiteSubmission(375914181917937698n, CONSENT);
		const visit = visited(liveCapture(CONSENT), METAMASK_VISIT);
		const answers = { ...KIT_ANSWERS, [GET_STARTED]: { ...KIT_ANSWERS[RECOVERY]!, evidenceQuote: "Import an existing wallet", collectionFieldRefs: [] } };
		await analyzeWebsite({ submissionId: id, url: CONSENT }, dependencies({ answers, captures: [], modelCalls, capture: () => visit.archive }));
		expect(modelCalls.map(({ url }) => url)).toEqual([CONSENT, GET_STARTED, GET_STARTED]);
		expect(websiteData(await SubmissionsEntity.get(id))?.archiveUrl).toBe(GET_STARTED);
		// The recovery form after the reportable page is where the values went in: it is evidence too.
		const names = (await ArtifactsEntity.listForSubmission(id)).map(({ name }) => name);
		expect(names).toEqual(expect.arrayContaining(["website-step3.mhtml", "website-step3-stamped.png", "evidence-step3-manifest.json"]));
		const manifest = JSON.parse((await ArtifactsEntity.get((await ArtifactsEntity.listForSubmission(id)).find(({ name }) => name === "evidence-step3-manifest.json")!.id))!.blob.toString("utf8"));
		expect(manifest.capture.capturedUrl).toBe(RECOVERY);
		// The case names it, so the visit's page viewer shows it after the judged page.
		expect(websiteData(await SubmissionsEntity.get(id))?.laterPages).toEqual([{ url: RECOVERY, step: 2 }]);
	});

	test("a visit that did not finish leaves a case with nothing reportable inconclusive, retried from the submitted URL; a later visit that finishes reports it", async () => {
		const id = await websiteSubmission(375914181917937692n, CONSENT);
		const failure = "failed: Error: the model answered HTTP 503";
		let visits = 0;
		const deps = dependencies({
			captures: [],
			capture: () => (++visits === 1
				? visited(liveCapture(CONSENT), { steps: [liveCapture(GET_STARTED)], agent: { outcome: "failed", failure, report: undefined } })
				: visited(liveCapture(CONSENT), METAMASK_VISIT)).archive,
		});

		await analyzeWebsite({ submissionId: id, url: CONSENT }, deps);
		let submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("failed");
		expect(submission?.info).toStartWith(`Inconclusive: the visit could not finish the site's flow: ${failure} The last page it reached, ${GET_STARTED}, shows nothing reportable by itself; no verdict or report was made. Retrying automatically at `);
		expect(websiteData(submission)).toMatchObject({ unfinishedFlow: failure, autoRetry: { attempts: 1, reason: failure } });
		expect(await AbuseRepository.getReportForSubmission(id)).toBeUndefined();

		// The retry visits the submitted URL live; the stored page of an unfinished visit is not reused.
		const retried: Array<Parameters<typeof analyzeWebsite>[0]> = [];
		await retryFailedWebsiteAnalysis(id, async (options) => { retried.push(options); });
		expect(retried).toEqual([expect.objectContaining({ url: CONSENT, mhtmlSnapshot: undefined, reuseEvidenceArtifacts: false })]);

		await analyzeWebsite(retried[0]!, deps);
		submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("reported");
		expect(websiteData(submission)?.unfinishedFlow).toBeUndefined();
		expect(websiteData(submission)?.autoRetry).toBeUndefined();
	});

	test("a finished visit that found nothing is a verdict, not a retry", async () => {
		const id = await websiteSubmission(375914181917937699n, CONSENT);
		const nothing = { ...KIT_ANSWERS, [RECOVERY]: { ...KIT_ANSWERS[CONSENT]! } };
		await analyzeWebsite({ submissionId: id, url: CONSENT }, dependencies({ answers: nothing, captures: [], capture: () => visited(liveCapture(CONSENT), METAMASK_VISIT).archive }));
		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("invalid");
		expect(submission?.info).toBe(`No reportable phishing or malware evidence was found at the captured destination ${RECOVERY}; no report was created.`);
		expect(websiteData(submission)?.autoRetry).toBeUndefined();
	});

	test("every live capture of the case presents the reporter's own browser; a report without one keeps the default", async () => {
		// Production case 380697679325302795: macmorrow.app showed its Terminal command
		// only to Macs, and the reporter's Chrome on macOS was one.
		const reporterHeaders = {
			"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
			"sec-ch-ua": "\"Not-A.Brand\";v=\"99\", \"Google Chrome\";v=\"157\", \"Chromium\";v=\"157\"",
			"sec-ch-ua-platform": "\"macOS\"",
		};
		const captures: ArchiveWebsiteOptions[] = [];
		// A capture without a session: the visit loads the page live once more.
		await analyzeWebsite({ submissionId: await websiteSubmission(380697679325302795n, CONSENT), url: CONSENT, reporterHeaders }, dependencies({ captures, capture: (options) => liveCapture(options.url) }));
		expect(captures.length).toBe(2);
		expect(captures.map(({ visitor }) => visitor)).toEqual([reporterBrowserIdentity(reporterHeaders), reporterBrowserIdentity(reporterHeaders)]);
		expect(captures[0]!.visitor?.override.platform).toBe("MacIntel");

		const anonymous: ArchiveWebsiteOptions[] = [];
		await analyzeWebsite({ submissionId: await websiteSubmission(380697679325302796n, CONSENT), url: CONSENT }, dependencies({ captures: anonymous, capture: (options) => liveCapture(options.url) }));
		expect(anonymous.length).toBe(2);
		expect(anonymous.every((options) => !("visitor" in options))).toBe(true);
	});

	test("a retry reuses the analyzed page's own capture, not the first page's", async () => {
		const id = await websiteSubmission(375914181917937691n, CONSENT);
		const unconfirmed = { ...KIT_ANSWERS, [RECOVERY]: { ...KIT_ANSWERS[CONSENT]! } };
		await analyzeWebsite({ submissionId: id, url: CONSENT }, dependencies({ answers: unconfirmed, captures: [], capture: () => visited(liveCapture(CONSENT), METAMASK_VISIT).archive }));
		// As if the analysis had failed after its captures: the case is retryable.
		await SubmissionsEntity.update(id, { status: "failed" });

		const started: Array<Parameters<typeof analyzeWebsite>[0]> = [];
		await retryFailedWebsiteAnalysis(id, async (options) => { started.push(options); });
		expect(started).toHaveLength(1);
		expect(started[0]!.archivedUrl).toBe(RECOVERY);
		expect(started[0]!.mhtmlSnapshot?.toString("utf8")).toContain(`Snapshot-Content-Location: ${RECOVERY}`);
		expect(started[0]!.reuseEvidenceArtifacts).toBe(true);
		expect(started[0]!.navigationHops?.filter((hop) => hop.visitorStep)).toHaveLength(2);
	});

	test("a visit whose flow reaches another site before anything reportable hands that site to its own case, as a redirect would", async () => {
		// Submission 379232259422556174: a shortener answers with a "Verify this
		// session" page; the agent presses "Continue" and lands on the kit's own domain.
		const SHORT = "https://encurtador09ea.com/sa";
		const SESSION_GATE = "https://encurtador09ea.com/e4d5b3c9a66e";
		const KIT = "https://en-web09.pw/login";
		PAGES[SESSION_GATE] = `<html><head><title>Verify this session</title></head><body><main><h1>Verify this session</h1>
<p>Press continue to open the page.</p><button type="button" id="go">Continue</button></main></body></html>`;
		PAGES[KIT] = `<html><head><title>Sign in</title></head><body><img alt="Microsoft"><h1>Sign in</h1>
<form method="POST"><input type="email" name="login" placeholder="Email"><input type="password" name="passwd" placeholder="Password"><button>Sign in</button></form></body></html>`;
		const answers: ClassifierAnswers = {
			[SESSION_GATE]: { finding: "insufficient_evidence", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], hiddenFrameRef: "", mobileHandoff: false },
			[KIT]: { finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "Sign in", collectionFieldRefs: ["f1", "f2"], hiddenFrameRef: "", mobileHandoff: false },
		};
		const captures: ArchiveWebsiteOptions[] = [];
		const visit = visited({ ...liveCapture(SESSION_GATE, hopsTo(SESSION_GATE, { url: SHORT, status: 302 })), requestedUrl: SHORT, ...RESIDENTIAL }, {
			steps: [{ ...liveCapture(KIT, hopsTo(KIT)), requestedUrl: SHORT, ...RESIDENTIAL }],
		});
		const id = await websiteSubmission(379232259422556174n, SHORT);

		await analyzeWebsite({ submissionId: id, url: SHORT }, dependencies({
			answers,
			captures,
			capture: (options) => (options.url === SHORT ? visit.archive : visited({ ...liveCapture(options.url), ...RESIDENTIAL }).archive),
		}));

		expect(visit.state.closed).toBeGreaterThanOrEqual(1);
		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("redirected");
		expect(submission?.info).toBe(`${SHORT} sends visitors on to en-web09.pw through its own flow; that site is analyzed and reported in its own case.`);
		expect(websiteData(submission)?.navigationHops?.map(({ url, status, visitorStep, contentCaptured }) => ({ url, status, moved: Boolean(visitorStep), contentCaptured }))).toEqual([
			{ url: SHORT, status: 302, moved: false, contentCaptured: false },
			{ url: SESSION_GATE, status: 200, moved: true, contentCaptured: false },
			{ url: KIT, status: 200, moved: false, contentCaptured: true },
		]);
		expect(await AbuseRepository.getReportForSubmission(id)).toBeUndefined();

		const child = await waitForStatus(BigInt(websiteData(submission)!.redirectSubmissionId!), ["reported", "failed", "invalid"]);
		expect(child.status).toBe("reported");
		expect(websiteData(child)?.url).toBe(KIT);
		expect(websiteData(child)?.navigationHops?.map(({ index, url }) => ({ index, url }))).toEqual([{ index: 0, url: KIT }]);
		expect((await AbuseRepository.getReportForSubmission(child.id))?.description).toContain('"Sign in"');
	});
});
