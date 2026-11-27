import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import type { AnalysisClient } from "../../analysis/run";
import { AbuseRepository } from "../../abuse/repository";
import { isKitSiblingSeed } from "../../abuse/origin/kit_job";
import { ArtifactsEntity } from "../../db/entities/artifacts";
import { SubmissionsEntity } from "../../db/entities/submissions";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { createWebsiteSubmission, websiteSubmissionDedupeKey } from "../../submissions/website";
import { ensureWebsiteVisitJobs } from "../visit_queue/run";
import { queuedVisits, runQueuedVisits } from "../visit_queue/test_helpers";
import type { WebsiteArchiveResult } from "../archive/types";
import { scriptedVisitSession } from "../../site_visit/test_helpers";
import { analyzeWebsite } from "./ai";
import type { WebsiteAnalysisDependencies } from "./analysis_types";
import { BROWSER_OUTAGE_RETRY_DELAYS_MS } from "./failure";
import { chainSiteAssessments, websiteReportUrls } from "../info/report_hops";
import type { WebsiteNavigationHop } from "../types";
import { waitForStatus, websiteSubmission } from "../test_helpers";
import { getDb } from "../../db";
import { jobs, abuseReports } from "../../abuse/schema";
import { REPORT_JOIN_WINDOW_MS } from "../../abuse/persistence/reports";
import { eq } from "drizzle-orm";
import { siteChecks, type SiteCheckState } from "../../liveness/schema";
import { generateId } from "../../db/ids";
import { reportConfirmedEmailPhishing } from "../../abuse/submission_reports";
import { readInvestigationJobPayload } from "../../investigation/payload";
import { runJoinedCaseInvestigation } from "../../investigation/run";
import { AbuseWorker } from "../../abuse/worker";
import { useTrackingTokenSecret } from "../../abuse/security/test_helpers";

useTemporaryDatabase();
useTrackingTokenSecret();

const NETFLIX_TEXT = "Netflix\nSign In\nEmail or phone number\nPassword\nSign In";
const NETFLIX_HTML = '<html><head><title>Netflix</title></head><body><h1>Sign In</h1><input type="text" id="iduserLoginId" aria-label="Email or phone number"><input type="password" id="idpassword" aria-label="Password"><button>Sign In</button></body></html>';
const MHTML = Buffer.from("From: <Saved by Blink>\r\nContent-Type: text/html\r\n\r\n<html><body>Netflix</body></html>", "utf8");
const PNG = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#ffffff" } })
	.composite([{ input: { create: { width: 16, height: 8, channels: 3, background: "#202124" } }, top: 8, left: 8 }])
	.png().toBuffer();

function hop(index: number, url: string, status: number | null, redirectTo?: string): WebsiteNavigationHop {
	return { index, url, hostname: new URL(url).hostname, status, ...(redirectTo ? { redirectTo } : {}), contentCaptured: !redirectTo };
}

function archiveOf(hops: WebsiteNavigationHop[]): WebsiteArchiveResult {
	const captured = hops.at(-1)!;
	return {
		requestedUrl: hops[0]!.url,
		url: captured.url,
		hostname: captured.hostname,
		navigationHops: hops,
		archivedAt: new Date("2026-10-27T10:00:00Z"),
		screenshotPng: PNG,
		mhtml: MHTML,
		html: Buffer.from(NETFLIX_HTML, "utf8"),
		text: Buffer.from(NETFLIX_TEXT, "utf8"),
		// The visit finds nothing beyond the captured page.
		session: scriptedVisitSession(),
	};
}

/** Streams the classification the production model returned for submission 373426928255766528, then the narrative. */
function phishingModel(): AnalysisClient {
	return scriptedModel([
		JSON.stringify({ finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "Sign In Email or phone number Password", collectionFieldRefs: ["f1", "f2"], hiddenFrameRef: "", mobileHandoff: false }),
		"The captured page impersonates Netflix and asks for an email and password.",
	]);
}

/** Classifies the captured page as harmless, as the model did for the Wikipedia decoy of submission 376291398434951215. */
function benignModel(): AnalysisClient {
	return scriptedModel([
		JSON.stringify({ finding: "benign", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], hiddenFrameRef: "", mobileHandoff: false }),
		"The page is a Wikipedia language and search landing page.",
	]);
}

function scriptedModel(outputs: string[]): AnalysisClient {
	let call = 0;
	return {
		responses: {
			create: async () => {
				const text = outputs[call++]!;
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

type ArchiveCall = Parameters<NonNullable<WebsiteAnalysisDependencies["archiveWebsite"]>>[0];

function dependencies(archive: WebsiteArchiveResult, archiveCalls: ArchiveCall[] = []): WebsiteAnalysisDependencies {
	return {
		getInfo: async () => ({ ip_rdaps: [] }),
		analysisClient: phishingModel(),
		domainRegistration: async () => undefined,
		// Never reach a real time-stamping authority from a test.
		timestampEvidence: async () => undefined,
		// A gated page's direct visit answers with the page itself.
		bareVisit: { fetch: (async () => new Response("ok")) as unknown as typeof fetch, assertPublicHost: async () => {} },
		// A handed-over capture is parsed from its MHTML; the fake returns the
		// same evidence with the provenance it was given.
		archiveWebsite: async (options) => {
			archiveCalls.push(options);
			if (!options.mhtmlSnapshot) return archive;
			const navigationHops = options.navigationHops!;
			return { ...archive, requestedUrl: options.url, url: options.archivedUrl!, hostname: new URL(options.archivedUrl!).hostname, navigationHops, screenshotPng: undefined, kitResources: options.kitResources };
		},
	};
}

describe("a brand's own site on a domain other than its main one", () => {
	test("the classifier is given who holds the domain and a web search, and its benign verdict reports nothing", async () => {
		// Production case 381762485331432790: AWS GovCloud's own IAM sign-in was reported to AWS as an AWS lookalike.
		const url = "https://signin.amazonaws-us-gov.com/oauth?client_id=arn%3Aaws-us-gov%3Asignin%3A%3A%3Aconsole%2Fcanvas";
		const archive = archiveOf([hop(0, url, 200)]);
		const requests: Array<{ tools?: unknown; input?: unknown; text?: { format?: unknown } }> = [];
		const recording = benignModel();
		const analysisClient = { responses: { create: async (options: typeof requests[number]) => { requests.push(options); return recording.responses.create(options as never); } } } as unknown as AnalysisClient;
		const lookups: string[] = [];
		const domainRegistration = async (hostname: string) => {
			lookups.push(hostname);
			return { domain: "amazonaws-us-gov.com", registrar: "MarkMonitor", brandProtectionRegistrar: true, registrant: "Amazon Technologies, Inc.", registered: "2012-08-13", nameservers: ["ns-1063.awsdns-04.org"] };
		};
		const id = await websiteSubmission(381762485331432790n, url);

		await analyzeWebsite({ submissionId: id, url }, { ...dependencies(archive), analysisClient, domainRegistration });

		const classification = requests.find((request) => request.text?.format);
		expect(classification?.tools).toEqual([{ type: "web_search" }]);
		const [system, user] = classification!.input as [{ content: string }, { content: Array<{ text: string }> }];
		expect(system.content).toContain("A brand's own page is not phishing");
		expect(system.content).toContain("search the web for the brand's official domains");
		expect(user.content[0]!.text).toContain("domain_registration:");
		expect(user.content[0]!.text).toContain("registrant: \"Amazon Technologies, Inc.\"");
		expect(user.content[0]!.text).toContain("brandProtectionRegistrar: true");
		expect(lookups).toEqual(["signin.amazonaws-us-gov.com"]);
		expect((await SubmissionsEntity.get(id))?.status).toBe("invalid");
		expect(await AbuseRepository.getReportForSubmission(id)).toBeUndefined();
	});
});

describe("a submitted address that serves a file, not a page", () => {
	test("a kit's script shown as text is never classified or reported, however much its source names a login", async () => {
		// Production case 381800243735303166: the kit-sibling search submitted become.vigilant009.com/gmail/js/start.js,
		// and the classifier "quoted" `const lg = \`${root}/gmail-login\`;` as phishing page text.
		const url = "https://become.vigilant009.com/gmail/js/start.js";
		const source = "const root = location.origin;\nconst lg = `${root}/gmail-login`;\nfetch(lg).then((r) => r.text()).then((html) => document.write(html));";
		const archive = { ...archiveOf([{ ...hop(0, url, 200), contentType: "text/javascript; charset=utf-8" }]), html: Buffer.from(`<html><body><pre>${source}</pre></body></html>`), text: Buffer.from(source) };
		const requests: Array<{ text?: { format?: unknown } }> = [];
		const recording = scriptedModel(["The address serves a JavaScript file."]);
		const analysisClient = { responses: { create: async (options: { text?: { format?: unknown } }) => { requests.push(options); return recording.responses.create(options as never); } } } as unknown as AnalysisClient;
		const id = await websiteSubmission(381800243735303166n, url);

		await analyzeWebsite({ submissionId: id, url }, { ...dependencies(archive), analysisClient });

		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("invalid");
		expect(submission?.info).toBe(`The classifier's finding for ${url} was not corroborated by the captured page: the captured address serves a file (text/javascript; charset=utf-8), not a web page a visitor is shown. No report was created.`);
		expect(requests.filter((request) => request.text?.format)).toEqual([]);
		expect(await AbuseRepository.getReportForSubmission(id)).toBeUndefined();
	});
});

describe("the case page while the written analysis runs", () => {
	test("the walked routes are stored before the analysis is asked for, so the visit's pages show meanwhile", async () => {
		// Production case 384583190792114178: the visit ended at 06:03:32, but its steps were stored only after the
		// streamed analysis finished at 06:06:19; the case page showed only the first capture all that time.
		const url = "https://willow.slon7.at/entry/login";
		const id = await websiteSubmission(384583190792114178n, url);
		const recording = phishingModel();
		const storedDuringAnalysis: unknown[] = [];
		const analysisClient = {
			responses: {
				create: async (options: { text?: { format?: unknown } }) => {
					if (!options.text?.format) storedDuringAnalysis.push(websiteOf(await SubmissionsEntity.get(id))?.routes?.map((route) => ({ hops: route.hops.map((hop) => hop.url), visited: route.visit !== undefined })));
					return recording.responses.create(options as never);
				},
			},
		} as unknown as AnalysisClient;

		await analyzeWebsite({ submissionId: id, url }, { ...dependencies(archiveOf([hop(0, url, 200)])), analysisClient });

		expect(storedDuringAnalysis).toEqual([[{ hops: [url], visited: true }]]);
		expect((await SubmissionsEntity.get(id))?.status).toBe("reported");
	});
});

/** The case's website data. */
function websiteOf(submission: Awaited<ReturnType<typeof SubmissionsEntity.get>>) {
	return submission?.data.kind === "website" ? submission.data.website : undefined;
}

/** Each hop's verdict, and the page it rests on. */
function verdicts(submission: Awaited<ReturnType<typeof SubmissionsEntity.get>>) {
	return websiteOf(submission)?.routes?.[0]?.siteAssessments?.map(({ hopIndex, finding, judgedHopIndex }) => ({ hopIndex, finding, judgedHopIndex }));
}

describe("website redirects", () => {
	test("an IP-hosted kit reached through a same-host http→https redirect is reported with both URLs", async () => {
		const httpUrl = "http://85.215.226.225/Netflix/Home/login.php";
		const httpsUrl = "https://85.215.226.225/Netflix/Home/login.php";
		const archive = archiveOf([hop(0, httpUrl, 307, httpsUrl), hop(1, httpsUrl, 200)]);
		const id = await websiteSubmission(373426928255766528n, httpUrl);

		await analyzeWebsite({ submissionId: id, url: httpUrl }, dependencies(archive));

		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("reported");
		expect(submission?.info).toBe(`Phishing confirmed at ${httpsUrl}; evidence for it and the 1 URL on 85.215.226.225 that leads to it is being collected before the report is sent.`);
		expect(verdicts(submission)).toEqual([
			{ hopIndex: 0, finding: "phishing", judgedHopIndex: 1 },
			{ hopIndex: 1, finding: "phishing", judgedHopIndex: 1 },
		]);

		const report = await AbuseRepository.getReportForSubmission(id);
		const targets = await AbuseRepository.listTargets(report!.id);
		expect(targets.map(({ normalizedTarget, targetType, observedUrls }) => ({ normalizedTarget, targetType, observedUrls }))).toEqual([
			{ normalizedTarget: "85.215.226.225", targetType: "ip", observedUrls: [httpsUrl, httpUrl] },
		]);
	});

	test("a capture that ends on another host is judged and reported in the submitted case, for the kit's host only", async () => {
		const shortUrl = "https://bit.ly/netflix-help";
		const kitStart = "http://login-netflix.example.com/";
		const kitPage = "https://login-netflix.example.com/signin";
		const kitResources = [{ url: "https://login-netflix.example.com/kit.js", mimeType: "application/javascript", size: 40_000, sha256: "a".repeat(64) }];
		const archive = { ...archiveOf([
			hop(0, shortUrl, 301, kitStart),
			hop(1, kitStart, 302, kitPage),
			hop(2, kitPage, 200),
		]), kitResources };
		const archiveCalls: ArchiveCall[] = [];
		const id = await websiteSubmission(1n, shortUrl);

		await analyzeWebsite({ submissionId: id, url: shortUrl }, dependencies(archive, archiveCalls));

		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("reported");
		expect(submission?.info).toBe(`Phishing confirmed at ${kitPage}; evidence for it and the 1 URL on login-netflix.example.com that leads to it is being collected before the report is sent.`);
		const website = websiteOf(submission);
		expect(website?.routes![0]!.hops).toEqual(archive.navigationHops);
		expect(website?.routes![0]!.analyzedHopIndex).toBe(2);
		expect(website?.archiveUrl).toBe(kitPage);
		expect(website?.kitResources).toEqual(kitResources);
		// The shortener only redirected: it showed no page of its own and never inherits the kit's verdict.
		expect(verdicts(submission)).toEqual([
			{ hopIndex: 0, finding: "insufficient_evidence", judgedHopIndex: undefined },
			{ hopIndex: 1, finding: "phishing", judgedHopIndex: 2 },
			{ hopIndex: 2, finding: "phishing", judgedHopIndex: 2 },
		]);
		// One capture, kept with the case that made it; no other case is opened.
		expect(archiveCalls).toHaveLength(1);
		expect((await ArtifactsEntity.listForSubmission(id)).map((artifact) => artifact.name).sort()).toEqual(["evidence-manifest.json", "visit-manifest.json", "visit-protocol.txt", "visit-record.json", "website-stamped.png", "website-thumb.webp", "website.mhtml", "website.png"]);
		expect((await SubmissionsEntity.listCards({ limit: 10 })).map((card) => card.id)).toEqual([id]);

		const reports = await AbuseRepository.listReportsForSubmission(id);
		expect(reports).toHaveLength(1);
		const targets = await AbuseRepository.listTargets(reports[0]!.id);
		expect(targets.map(({ normalizedTarget, observedUrls }) => ({ normalizedTarget, observedUrls }))).toEqual([
			{ normalizedTarget: "login-netflix.example.com", observedUrls: [kitPage, kitStart] },
		]);
		// Its campaign's kit search may start from it: an original report's site.
		expect(await isKitSiblingSeed(id)).toBe(true);
	});

	test("a second site on a shared host opens its own case and is reported on its own", async () => {
		const reported = "https://sites.google.com/view/start-trezor-suite";
		const { id: existingId } = await createWebsiteSubmission({ url: reported });
		await SubmissionsEntity.update(existingId, { status: "reported" });

		const url = "https://sites.google.com/view/revert-change";
		const page = "https://sites.google.com/view/revert-change/login";
		const { id } = await createWebsiteSubmission({ url });
		await runQueuedVisits((options) => analyzeWebsite(options, dependencies(archiveOf([hop(0, url, 302, page), hop(1, page, 200)]))));
		expect(id).not.toBe(existingId);
		// The same site submitted again still lands on its own case.
		expect((await createWebsiteSubmission({ url: "https://sites.google.com/view/Revert-Change/" })).id).toBe(id);

		const submission = await waitForStatus(id, ["reported", "failed", "invalid"]);
		expect(submission.status).toBe("reported");
		expect(submission.info).toBe(`Phishing confirmed at ${page}; evidence for it and the 1 URL on sites.google.com/view/revert-change that leads to it is being collected before the report is sent.`);
		const report = await AbuseRepository.getReportForSubmission(id);
		const targets = await AbuseRepository.listTargets(report!.id);
		expect(targets.map(({ normalizedTarget, observedUrls }) => ({ normalizedTarget, observedUrls }))).toEqual([
			{ normalizedTarget: "sites.google.com", observedUrls: [page, url] },
		]);
	});

	test("a redirect from one tenant of a shared host to another judges each tenant as its own site", async () => {
		const url = "https://sites.google.com/view/landing";
		const kitPage = "https://sites.google.com/view/wallet-restore/home";
		const id = await websiteSubmission(3n, url);

		await analyzeWebsite({ submissionId: id, url }, dependencies(archiveOf([hop(0, url, 302, kitPage), hop(1, kitPage, 200)])));

		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("reported");
		expect(submission?.info).toBe(`Phishing confirmed at ${kitPage}; its evidence is being collected before the report is sent.`);
		expect(verdicts(submission)).toEqual([
			{ hopIndex: 0, finding: "insufficient_evidence", judgedHopIndex: undefined },
			{ hopIndex: 1, finding: "phishing", judgedHopIndex: 1 },
		]);
		const report = await AbuseRepository.getReportForSubmission(id);
		expect((await AbuseRepository.listTargets(report!.id)).map(({ normalizedTarget, observedUrls }) => ({ normalizedTarget, observedUrls }))).toEqual([
			{ normalizedTarget: "sites.google.com", observedUrls: [kitPage] },
		]);
	});

	test("a redirect to a harmless site is the host's declared destination: a verdict, never a cloaking suspicion", async () => {
		const url = "https://short.example.org/wiki";
		const decoy = "https://www.wikipedia.org/";
		const id = await websiteSubmission(14n, url);

		await analyzeWebsite({ submissionId: id, url }, { ...dependencies(archiveOf([hop(0, url, 302, decoy), hop(1, decoy, 200)])), analysisClient: benignModel() });

		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("invalid");
		expect(submission?.info).toBe(`No reportable phishing or malware evidence was found at the captured destination ${decoy}; no report was created.`);
		expect(websiteOf(submission)?.cloaking).toBeUndefined();
		expect(verdicts(submission)).toEqual([
			{ hopIndex: 0, finding: "insufficient_evidence", judgedHopIndex: undefined },
			{ hopIndex: 1, finding: "benign", judgedHopIndex: 1 },
		]);
	});
});

describe("one report per site across cases", () => {
	const kitPage = "https://kit.example.net/login";
	const lure = (index: number) => `https://lure-${index}.example.org/x`;
	const reachKit = (id: bigint, from: string) => analyzeWebsite({ submissionId: id, url: from }, dependencies(archiveOf([hop(0, from, 302, kitPage), hop(1, kitPage, 200)])));

	test("a second case that reaches a site another case is reporting joins that report: one report, naming both cases", async () => {
		const first = await websiteSubmission(20n, lure(1));
		await reachKit(first, lure(1));
		const report = await AbuseRepository.getReportForSubmission(first);
		expect(report).toBeDefined();

		const second = await websiteSubmission(21n, lure(2));
		await reachKit(second, lure(2));

		const submission = await SubmissionsEntity.get(second);
		expect(submission?.status).toBe("reported");
		expect(submission?.info).toBe(`Phishing confirmed at ${kitPage}; kit.example.net is already being reported in case ${first.toString()}, whose report now names this case too.`);
		// The second case owns no report of its own; the first one's is linked to it and says so.
		expect(await AbuseRepository.listReportsForSubmission(second)).toEqual([]);
		expect((await AbuseRepository.listJoinedReportsForSubmission(second)).map(({ id }) => id)).toEqual([report!.id]);
		expect(await AbuseRepository.listJoinedCases(report!.id)).toEqual([second]);
		const joined = (await AbuseRepository.listEvents(report!.id)).filter((event) => event.eventType === "report.case_joined");
		expect(joined.map(({ data }) => data)).toEqual([{ submissionId: second.toString(), urls: [kitPage] }]);
		// Its redirector is watched under the shared report: another lure of the same kit.
		const watches = (await getDb()).select().from(jobs).where(eq(jobs.jobType, "watch_redirector")).all();
		expect(watches.map(({ reportId, dedupeKey }) => ({ reportId, dedupeKey }))).toEqual([
			{ reportId: report!.id, dedupeKey: `watch-redirector:${lure(1)}` },
			{ reportId: report!.id, dedupeKey: `watch-redirector:${lure(2)}` },
		]);

		// A replayed analysis of either case adds nothing: no second report, link or event.
		await reachKit(second, lure(2));
		await reachKit(first, lure(1));
		expect(await AbuseRepository.listJoinedCases(report!.id)).toEqual([second]);
		expect((await AbuseRepository.listEvents(report!.id)).filter((event) => event.eventType === "report.case_joined")).toHaveLength(1);
		expect(await AbuseRepository.listReportsForSubmission(first)).toHaveLength(1);
	});

	test("a case whose only site joined another case's report still reports its own data drops and redirector, against that report", async () => {
		const first = await websiteSubmission(22n, lure(1));
		await reachKit(first, lure(1));
		const report = (await AbuseRepository.getReportForSubmission(first))!;

		// The second lure's visit saw the kit send the made-up password to a Telegram bot.
		const bot = "https://api.telegram.org/bot8123456789:AAH-kit-token/sendMessage";
		const second = await websiteSubmission(23n, lure(2));
		const archive = { ...archiveOf([hop(0, lure(2), 302, kitPage), hop(1, kitPage, 200)]), session: scriptedVisitSession({
			requests: (canaries) => [{ timestamp: "2026-11-15T10:00:01.500Z", url: bot, method: "POST", postData: JSON.stringify({ chat_id: "-100777", text: `pass: ${canaries.password}` }) }],
		}) };
		await analyzeWebsite({ submissionId: second, url: lure(2) }, dependencies(archive));
		expect((await AbuseRepository.listJoinedReportsForSubmission(second)).map(({ id }) => id)).toEqual([report.id]);

		const queuedJobs = (await getDb()).select().from(jobs).where(eq(jobs.jobType, "investigate_joined_case")).all();
		expect(queuedJobs.map(({ reportId, dedupeKey }) => ({ reportId, dedupeKey }))).toEqual([{ reportId: report.id, dedupeKey: `investigate-joined:${second.toString()}:${report.id.toString()}` }]);
		// The joined site is linked into its campaign by this case's own evidence, as a member through the joined report.
		const links = (await getDb()).select().from(jobs).where(eq(jobs.jobType, "link_campaign")).all();
		expect(links.map(({ dedupeKey }) => dedupeKey)).toContain(`campaign-link:${second.toString()}:${report.id.toString()}`);
		const payload = readInvestigationJobPayload(queuedJobs[0]!.payload);
		expect(payload).toMatchObject({ submissionId: second.toString(), pageUrl: kitPage, finding: { finding: "phishing" } });
		expect(payload.dataDrops?.map(({ kind, key }) => ({ kind, key }))).toEqual([{ kind: "telegram_bot", key: "telegram-token:8123456789:AAH-kit-token" }]);
		const website = (await SubmissionsEntity.get(second))!.data;
		expect(website.kind === "website" && website.website.investigation?.status).toBe("queued");

		// The worker runs it: the bot is reported by this case, linked to the joined report, and so is its redirector.
		const redirectors: Array<{ reportId: bigint; submissionId: bigint; pageUrl: string }> = [];
		const worker = new AbuseWorker({
			owner: "joined-case-test",
			investigateJoinedCase: (params) => runJoinedCaseInvestigation(params, {
				enrich: async (backend) => backend,
				reportRedirector: async ({ reportId, submissionId, pageUrl }) => {
					redirectors.push({ reportId, submissionId, pageUrl });
					return { kind: "skipped", url: lure(2), reason: "test" };
				},
			}),
		});
		expect(await worker.processOne({ jobTypes: ["investigate_joined_case"] })).toBeTrue();
		expect(redirectors).toEqual([{ reportId: report.id, submissionId: second, pageUrl: kitPage }]);
		const drops = await AbuseRepository.listReportsForSubmission(second);
		expect(drops.map(({ idempotencyKey }) => idempotencyKey)).toEqual([expect.stringMatching(new RegExp(`^exfil:${second.toString()}:`))]);
		expect((await AbuseRepository.listTargets(drops[0]!.id)).map(({ normalizedTarget }) => normalizedTarget)).toEqual(["telegram-bot:8123456789"]);
		const [original] = await AbuseRepository.listArtifacts(drops[0]!.id, ["original_request"]);
		expect(JSON.parse(Buffer.from(original!.blob).toString("utf8"))).toMatchObject({ kind: "exfiltration_backend", submissionId: second.toString(), sourceReportId: report.id.toString(), pageUrl: kitPage });
		// This case's own page is the evidence, not the joined case's.
		expect((await AbuseRepository.getReportInput(drops[0]!.id))!.evidenceArtifacts.map(({ name }) => name)).toContain("exfiltration-evidence.json");
		const after = (await SubmissionsEntity.get(second))!.data;
		expect(after.kind === "website" && after.website.investigation).toMatchObject({ status: "completed", backendCount: 1 });
		expect((await AbuseRepository.listEvents(report.id)).filter(({ eventType }) => eventType === "redirector.skipped").map(({ data }) => data)).toEqual([{ submissionId: second.toString(), url: lure(2), reason: "test" }]);
		// The owning report was never held or released again.
		expect((await AbuseRepository.getReport(report.id))!.status).toBe(report.status);

		// A replayed analysis queues nothing twice.
		await analyzeWebsite({ submissionId: second, url: lure(2) }, dependencies(archive));
		expect((await getDb()).select().from(jobs).where(eq(jobs.jobType, "investigate_joined_case")).all()).toHaveLength(1);
	});

	test("a joined case's evidence job that keeps failing says so on the case, and leaves the joined report alone", async () => {
		const first = await websiteSubmission(24n, lure(1));
		await reachKit(first, lure(1));
		const report = (await AbuseRepository.getReportForSubmission(first))!;
		const second = await websiteSubmission(25n, lure(2));
		await reachKit(second, lure(2));
		const worker = new AbuseWorker({ owner: "joined-case-failure", investigateJoinedCase: async () => { throw new Error("lookup down"); } });
		for (let attempt = 0; attempt < 20 && (await getDb()).select().from(jobs).where(eq(jobs.jobType, "investigate_joined_case")).get()?.status !== "failed"; attempt++) {
			(await getDb()).update(jobs).set({ nextAttemptAt: new Date(0) }).where(eq(jobs.jobType, "investigate_joined_case")).run();
			await worker.processOne({ jobTypes: ["investigate_joined_case"] });
		}
		const data = (await SubmissionsEntity.get(second))!.data;
		expect(data.kind === "website" && data.website.investigation).toMatchObject({ status: "failed", lastError: expect.stringContaining("lookup down") });
		expect((await AbuseRepository.getReport(report.id))!.status).toBe(report.status);
	});

	test("a site whose report never reached a provider, or was sent over a month ago, is reported anew", async () => {
		const first = await websiteSubmission(30n, lure(1));
		await reachKit(first, lure(1));
		const report = (await AbuseRepository.getReportForSubmission(first))!;
		const db = await getDb();

		db.update(abuseReports).set({ status: "no_route" }).where(eq(abuseReports.id, report.id)).run();
		const second = await websiteSubmission(31n, lure(2));
		await reachKit(second, lure(2));
		const secondReport = await AbuseRepository.getReportForSubmission(second);
		expect(secondReport?.id).not.toBe(report.id);

		db.update(abuseReports).set({ createdAt: new Date(Date.now() - REPORT_JOIN_WINDOW_MS - 60_000) }).where(eq(abuseReports.id, secondReport!.id)).run();
		const third = await websiteSubmission(32n, lure(3));
		await reachKit(third, lure(3));
		expect((await AbuseRepository.getReportForSubmission(third))?.id).not.toBe(secondReport!.id);
		expect(await AbuseRepository.listJoinedReportsForSubmission(third)).toEqual([]);
	});

	test("a report an operator must still decide on, or whose site our checks found taken down, is not joined", async () => {
		const first = await websiteSubmission(33n, lure(1));
		await reachKit(first, lure(1));
		const report = (await AbuseRepository.getReportForSubmission(first))!;
		const db = await getDb();

		db.update(abuseReports).set({ status: "needs_human" }).where(eq(abuseReports.id, report.id)).run();
		const second = await websiteSubmission(34n, lure(2));
		await reachKit(second, lure(2));
		const secondReport = (await AbuseRepository.getReportForSubmission(second))!;
		expect(secondReport.id).not.toBe(report.id);
		expect(await AbuseRepository.listJoinedReportsForSubmission(second)).toEqual([]);

		// A page that answers 404 is no takedown (kits cloak that way): the report stays open and is joined…
		const [target] = await AbuseRepository.listTargets(secondReport.id);
		const check = (state: SiteCheckState) => db.insert(siteChecks).values({ id: generateId(), reportId: secondReport.id, targetId: target!.id, url: kitPage, state, checkedAt: new Date() }).run();
		check("removed");
		const third = await websiteSubmission(35n, lure(3));
		await reachKit(third, lure(3));
		expect((await AbuseRepository.listJoinedReportsForSubmission(third)).map(({ id }) => id)).toEqual([secondReport.id]);

		// …a suspended domain is: the kit is back, and a later case reports it anew.
		check("domain_suspended");
		const fourth = await websiteSubmission(36n, lure(4));
		await reachKit(fourth, lure(4));
		expect(await AbuseRepository.listJoinedReportsForSubmission(fourth)).toEqual([]);
		expect((await AbuseRepository.getReportForSubmission(fourth))?.id).not.toBe(secondReport.id);
	});

	test("an email report that names the site's address as its sending IP is not the site's report", async () => {
		const ip = "93.184.216.34";
		const email = await SubmissionsEntity.create({ kind: "email", data: { kind: "email" }, dedupeKey: "email-joined-ip" });
		const emailReport = await reportConfirmedEmailPhishing({ submissionId: email, analysisText: "A Netflix phishing mail.", reporter: {}, redactedEml: "From: a@b.c\r\n\r\nNetflix", sendingIp: ip });
		expect((await AbuseRepository.listTargets(emailReport.reportId)).map(({ normalizedTarget }) => normalizedTarget)).toContain(ip);

		const page = `http://${ip}/login`;
		const site = await websiteSubmission(37n, page);
		await analyzeWebsite({ submissionId: site, url: page }, dependencies(archiveOf([hop(0, page, 200)])));
		expect(await AbuseRepository.listJoinedReportsForSubmission(site)).toEqual([]);
		const own = await AbuseRepository.getReportForSubmission(site);
		expect(own && own.id !== emailReport.reportId).toBe(true);
	});

	test("another tenant of the same shared host is another site: its own report", async () => {
		const tenant = (name: string) => `https://sites.google.com/view/${name}/login`;
		const first = await websiteSubmission(40n, tenant("one"));
		await analyzeWebsite({ submissionId: first, url: tenant("one") }, dependencies(archiveOf([hop(0, tenant("one"), 200)])));
		const second = await websiteSubmission(41n, tenant("two"));
		await analyzeWebsite({ submissionId: second, url: tenant("two") }, dependencies(archiveOf([hop(0, tenant("two"), 200)])));

		const [one, two] = await Promise.all([AbuseRepository.getReportForSubmission(first), AbuseRepository.getReportForSubmission(second)]);
		expect(one && two && one.id !== two.id).toBe(true);
		expect(await AbuseRepository.listJoinedReportsForSubmission(second)).toEqual([]);
	});
});

describe("the sites of a chain", () => {
	const hops = [
		hop(0, "https://bit.ly/a", 301, "http://kit.example.com/"),
		hop(1, "http://kit.example.com/", 302, "https://kit.example.com/"),
		hop(2, "https://kit.example.com/", 302, "https://www.kit.example.com/login"),
		hop(3, "https://www.kit.example.com/login", 200),
	];
	const phishing = { finding: "phishing" as const, phishingBasis: "credential_theft" as const, evidenceQuote: "Sign In" };

	test("only an exact hostname counts as the same site", () => {
		expect(websiteReportUrls(hops, hops[3]!)).toEqual(["https://www.kit.example.com/login"]);
		expect(chainSiteAssessments(hops, new Map([["www.kit.example.com", { judgedHopIndex: 3, classification: phishing }]])).map(({ hopIndex, finding }) => ({ hopIndex, finding }))).toEqual([
			{ hopIndex: 0, finding: "insufficient_evidence" },
			{ hopIndex: 1, finding: "insufficient_evidence" },
			{ hopIndex: 2, finding: "insufficient_evidence" },
			{ hopIndex: 3, finding: "phishing" },
		]);
	});

	test("a site's redirect hops share its verdict and are reported with its page; other sites never inherit it", () => {
		const sameHost = hops.slice(0, 3).concat({ ...hop(3, "https://kit.example.com/login", 200) });
		expect(websiteReportUrls(sameHost, sameHost[3]!)).toEqual([
			"https://kit.example.com/login",
			"http://kit.example.com/",
			"https://kit.example.com/",
		]);
		const assessments = chainSiteAssessments(sameHost, new Map([["kit.example.com", { judgedHopIndex: 3, classification: phishing }]]));
		expect(assessments).toEqual([
			{ hopIndex: 0, finding: "insufficient_evidence" },
			{ ...phishing, hopIndex: 1, judgedHopIndex: 3 },
			{ ...phishing, hopIndex: 2, judgedHopIndex: 3 },
			{ ...phishing, hopIndex: 3, judgedHopIndex: 3 },
		]);
	});

	test("every site of a multi-site chain keeps its own verdict: trackers, an interstitial and the destination", () => {
		// The design's example: onlinesafetyall.com → wtrck.com → ultimateprizesearch.com (a page whose script moves on) → wtrck.com → sdsecurenetwork.com → miamitrk.com → zatos.com.
		const chain = [
			hop(0, "https://onlinesafetyall.com/", 302, "https://wtrck.com/a"),
			hop(1, "https://wtrck.com/a", 302, "https://ultimateprizesearch.com/"),
			{ ...hop(2, "https://ultimateprizesearch.com/", 200, "https://wtrck.com/b"), bodyCaptured: true },
			hop(3, "https://wtrck.com/b", 302, "https://sdsecurenetwork.com/"),
			hop(4, "https://sdsecurenetwork.com/", 302, "https://miamitrk.com/c"),
			hop(5, "https://miamitrk.com/c", 302, "https://zatos.com/"),
			hop(6, "https://zatos.com/", 200),
		];
		const benign = { finding: "benign" as const };
		const assessments = chainSiteAssessments(chain, new Map([
			["ultimateprizesearch.com", { judgedHopIndex: 2, classification: benign }],
			["zatos.com", { judgedHopIndex: 6, classification: phishing }],
		]));
		expect(assessments.map(({ hopIndex, finding, judgedHopIndex }) => ({ hopIndex, finding, judgedHopIndex }))).toEqual([
			{ hopIndex: 0, finding: "insufficient_evidence", judgedHopIndex: undefined },
			// The tracker appears twice; it showed nothing either time.
			{ hopIndex: 1, finding: "insufficient_evidence", judgedHopIndex: undefined },
			{ hopIndex: 2, finding: "benign", judgedHopIndex: 2 },
			{ hopIndex: 3, finding: "insufficient_evidence", judgedHopIndex: undefined },
			{ hopIndex: 4, finding: "insufficient_evidence", judgedHopIndex: undefined },
			{ hopIndex: 5, finding: "insufficient_evidence", judgedHopIndex: undefined },
			{ hopIndex: 6, finding: "phishing", judgedHopIndex: 6 },
		]);
		expect(websiteReportUrls(chain, chain[6]!)).toEqual(["https://zatos.com/"]);
	});
});

test("a new website submission hands its options to the analysis it starts", async () => {
	const started: unknown[] = [];
	const { id, status } = await createWebsiteSubmission({ url: "https://fresh.example.com/" });
	expect(status).toBe("queued");
	await runQueuedVisits(async (options) => started.push(options));
	expect(started).toEqual([{ submissionId: id, url: "https://fresh.example.com/" }]);
});

describe("cloaked websites", () => {
	const cloakerUrl = "https://lookup-lgr.to/en/verification";
	const kitUrl = "https://device.ledger-config.live/en";
	const decoyUrl = "https://www.wikipedia.org/";

	test("a cloaker whose residential capture reached the kit has the kit reported in its own case, the jump kept as how it was reached", async () => {
		const detail = `${cloakerUrl} sent the residential exit to ledger-config.live by script`;
		const archive = { ...archiveOf([hop(0, cloakerUrl, 200, kitUrl), hop(1, kitUrl, 200)]), cloaking: { outcome: "scripted" as const, detail } };
		const id = await websiteSubmission(374589286864916480n, cloakerUrl);

		await analyzeWebsite({ submissionId: id, url: cloakerUrl }, dependencies(archive));

		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("reported");
		expect(submission?.info).toBe(`Phishing confirmed at ${kitUrl}; its evidence is being collected before the report is sent.`);
		expect(websiteOf(submission)?.cloaking).toEqual({ outcome: "scripted", detail });
		expect(verdicts(submission)).toEqual([
			{ hopIndex: 0, finding: "insufficient_evidence", judgedHopIndex: undefined },
			{ hopIndex: 1, finding: "phishing", judgedHopIndex: 1 },
		]);
		const report = await AbuseRepository.getReportForSubmission(id);
		expect((await AbuseRepository.listTargets(report!.id)).map(({ normalizedTarget }) => normalizedTarget)).toEqual(["device.ledger-config.live"]);
	});

	test("a cloaker that sent the residential exit to another harmless site fails as suspected cloaking, decided in its own case", async () => {
		// docusign.alt3-doc3ea7-v2.sbs (submission 376813288618463354) answers every
		// visit with `location.replace` to a random news front page.
		const submitted = "https://docusign.alt3-doc3ea7-v2.sbs/word/verify.workspace.php";
		const residentialDecoy = "https://www.bbc.com/";
		const detail = `${submitted} sent the residential exit to bbc.com by script`;
		const archive = { ...archiveOf([hop(0, submitted, 200, residentialDecoy), hop(1, residentialDecoy, 200)]), cloaking: { outcome: "scripted" as const, detail } };
		const id = await websiteSubmission(376813288618463354n, submitted);

		await analyzeWebsite({ submissionId: id, url: submitted }, { ...dependencies(archive), analysisClient: benignModel() });

		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("failed");
		expect(submission?.info).toBe(`Cloaking suspected: ${detail}, which shows nothing reportable. No verdict or report was made from the decoy; retry to visit the site again.`);
		expect(websiteOf(submission)?.cloaking).toEqual({ outcome: "unresolved", detail: `${detail}, which shows nothing reportable` });
		// The decoy was judged where it was reached; no other case is opened for it.
		expect(verdicts(submission)).toEqual([
			{ hopIndex: 0, finding: "insufficient_evidence", judgedHopIndex: undefined },
			{ hopIndex: 1, finding: "benign", judgedHopIndex: 1 },
		]);
		expect((await SubmissionsEntity.listCards({ limit: 10 })).map((card) => card.id)).toEqual([id]);
		expect(await AbuseRepository.getReportForSubmission(id)).toBeUndefined();
	});

	test("a decoy-only capture is kept as evidence but never classified or reported as not phishing", async () => {
		const detail = `${cloakerUrl} sent the Tor exit to wikipedia.org by script; Failed to load page: net::ERR_INTERNET_DISCONNECTED via residential exit`;
		const archive = { ...archiveOf([hop(0, cloakerUrl, 200, decoyUrl), hop(1, decoyUrl, 200)]), cloaking: { outcome: "unresolved" as const, detail } };
		let modelCalls = 0;
		const deps = { ...dependencies(archive), analysisClient: { responses: { create: async () => { modelCalls++; throw new Error("must not classify a decoy"); } } } as unknown as AnalysisClient };
		const id = await websiteSubmission(2n, cloakerUrl);

		await analyzeWebsite({ submissionId: id, url: cloakerUrl }, deps);

		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("failed");
		expect(submission?.info).toBe(`Cloaking suspected: ${detail}. No verdict or report was made from the decoy; retry to visit the site again.`);
		expect(websiteOf(submission)?.cloaking).toEqual({ outcome: "unresolved", detail });
		expect(modelCalls).toBe(0);
		expect(await AbuseRepository.getReportForSubmission(id)).toBeUndefined();
		// The decoy is kept with its evidence package, so it is documented like any capture.
		expect((await ArtifactsEntity.listForSubmission(id)).map((artifact) => artifact.kind).filter((kind) => kind !== "website_evidence").sort()).toEqual(["website_mhtml", "website_png", "website_thumbnail"]);
	});
});

describe("scripted jumps of the residential exit to another site", () => {
	const cloakerUrl = "https://apple-condition.com/en/verification";
	const decoyUrl = "https://www.wikipedia.org/";
	const kitUrl = "https://login-netflix.example.com/signin";
	const uniform = (destination: string, submitted = cloakerUrl) => ({
		outcome: "scripted" as const,
		detail: `${submitted} sent the residential exit to ${new URL(destination).hostname.replace(/^www\./, "")} by script`,
	});
	const uniformArchive = (destination: string, submitted = cloakerUrl) => ({ ...archiveOf([hop(0, submitted, 200, destination), hop(1, destination, 200)]), cloaking: uniform(destination, submitted) });

	test("a harmless destination fails the submitted case as suspected cloaking, retryable, with the chain kept", async () => {
		const archive = uniformArchive(decoyUrl);
		const id = await websiteSubmission(376291398434951215n, cloakerUrl);

		await analyzeWebsite({ submissionId: id, url: cloakerUrl }, { ...dependencies(archive), analysisClient: benignModel() });

		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("failed");
		const detail = `${uniform(decoyUrl).detail}, which shows nothing reportable`;
		expect(submission?.info).toBe(`Cloaking suspected: ${detail}. No verdict or report was made from the decoy; retry to visit the site again.`);
		expect(websiteOf(submission)?.cloaking).toEqual({ outcome: "unresolved", detail });
		expect(websiteOf(submission)?.routes?.[0]?.hops).toEqual(archive.navigationHops);
		expect(await AbuseRepository.getReportForSubmission(id)).toBeUndefined();
	});

	test("another case's earlier verdict on the destination never decides this one: it is judged again where it was reached", async () => {
		// The kit's own case found nothing when it was visited before.
		await SubmissionsEntity.create({ id: 60n, kind: "website", data: { kind: "website", website: { url: kitUrl } }, dedupeKey: websiteSubmissionDedupeKey(kitUrl), status: "invalid" });
		const id = await websiteSubmission(11n, cloakerUrl);

		await analyzeWebsite({ submissionId: id, url: cloakerUrl }, dependencies(uniformArchive(kitUrl)));

		expect((await SubmissionsEntity.get(id))?.status).toBe("reported");
		expect((await SubmissionsEntity.get(60n))?.status).toBe("invalid");
	});

	test("a page reached only through an entry's one-time link is reported with how to reach it and what a direct visit gets", async () => {
		// Production case 381727464776274088: Cloudflare opened lbbvw.com/ without the session and found nothing.
		const entry = "https://f24ac216.37b963ba383fc01de7edcef8.workers.dev/";
		const ticket = "https://lbbvw.com/?dataXX0=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1cmwiOiJodHRwczovL2xiYnZ3LmNvbS8iLCJkb21haW4iOiJsYmJ2dy5jb20iLCJrZXkiOiJTUlZ3UWJuZjAzb2QiLCJxcmMiOm51bGwsImlhdCI6MTc5NTA3ODA2MCwiZXhwIjoxNzk1MDc4MTgwfQ.qAQe7AM6yZdPpNWwd5ao1NTlafcHGAFeYM_Ue6L02qA";
		const page = "https://lbbvw.com/";
		const id = await websiteSubmission(70n, entry);
		const archive = archiveOf([{ ...hop(0, entry, 200, entry), visitorStep: { submitted: [] } }, hop(1, entry, 302, ticket), hop(2, ticket, 302, page), hop(3, page, 200)]);
		const bareRequests: string[] = [];
		const decoy = (async (input: URL | RequestInfo) => {
			bareRequests.push(String(input));
			return String(input) === page ? new Response(null, { status: 302, headers: { location: "https://href.li/?https://example.com" } }) : new Response("ok");
		}) as typeof fetch;

		await analyzeWebsite({ submissionId: id, url: entry }, { ...dependencies(archive), bareVisit: { fetch: decoy, assertPublicHost: async () => {} } });

		expect((await SubmissionsEntity.get(id))?.status).toBe("reported");
		const report = await AbuseRepository.getReportForSubmission(id);
		expect(report!.description).toContain(`Victims are sent to ${entry}, a link on another site, which first has them pass a check page of its own and then forwards each of them to lbbvw.com.`);
		expect(report!.description).toContain("one-time link whose token is valid for only 2 minutes");
		expect(report!.description).toContain(`Opened without that session, ${page} sends visitors to https://href.li/?https://example.com`);
		expect(report!.description).toContain(`To see the page, follow ${entry} in a browser and continue straight through; our capture of what victims see, with screenshots, is at `);
		// Kept with the case for answers to providers; the page was requested once, without a session.
		expect(websiteOf(await SubmissionsEntity.get(id))?.accessGate).toMatchObject({ entryUrl: entry, entryStep: true, ticket: { lifetimeSeconds: 120 }, bareVisit: { url: page, reachedUrl: "https://href.li/?https://example.com" } });
		expect(bareRequests).toEqual([page, "https://href.li/?https://example.com"]);
	});

	test("a phishing destination is reported in the submitted case, which keeps its scripted jump", async () => {
		const id = await websiteSubmission(10n, cloakerUrl);

		await analyzeWebsite({ submissionId: id, url: cloakerUrl }, dependencies(uniformArchive(kitUrl)));

		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("reported");
		expect(websiteOf(submission)?.cloaking).toEqual(uniform(kitUrl));
		const report = await AbuseRepository.getReportForSubmission(id);
		expect((await AbuseRepository.listTargets(report!.id)).map(({ normalizedTarget, observedUrls }) => ({ normalizedTarget, observedUrls }))).toEqual([
			{ normalizedTarget: "login-netflix.example.com", observedUrls: [kitUrl] },
		]);
	});
});

describe("browser-service failures", () => {
	const url = "https://app.karntappkrakurl.es/naivator/captcha/sign-in.php";
	// What puppeteer under Bun rejects with when the relay is full: an ErrorEvent, not an Error.
	const relayFull = () => Object.assign(new Event("error"), { message: "Unexpected server response: 503" });

	test("a capture that loses the browser is retried with backoff and then succeeds", async () => {
		const archive = archiveOf([hop(0, url, 200)]);
		let attempts = 0;
		const id = await websiteSubmission(374703356112802863n, url);

		await analyzeWebsite({ submissionId: id, url }, {
			...dependencies(archive),
			browserBackoffMs: [1, 1, 1],
			archiveWebsite: async () => {
				attempts++;
				if (attempts === 1) throw relayFull();
				if (attempts === 2) throw new Error("Protocol error (Target.getBrowserContexts): Target closed");
				return archive;
			},
		});

		expect(attempts).toBe(3);
		expect((await SubmissionsEntity.get(id))?.status).toBe("reported");
	});

	test("a lasting browser outage fails with a readable reason and retries progressively across 24 hours before giving up", async () => {
		expect(BROWSER_OUTAGE_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)).toBe(24 * 60 * 60_000);
		const totalRetries = BROWSER_OUTAGE_RETRY_DELAYS_MS.length;
		const id = await websiteSubmission(374703356112802864n, url);
		const failing = { ...dependencies(archiveOf([hop(0, url, 200)])), browserBackoffMs: [1], archiveWebsite: async () => { throw relayFull(); } };
		const run = () => analyzeWebsite({ submissionId: id, url }, failing);
		const autoRetryOf = async () => {
			const submission = (await SubmissionsEntity.get(id))!;
			return { submission, autoRetry: submission.data.kind === "website" ? submission.data.website.autoRetry : undefined };
		};

		const beforeFirst = Date.now();
		await run();
		let { submission, autoRetry } = await autoRetryOf();
		expect(submission.status).toBe("failed");
		expect(submission.info).toStartWith("The browser service failed (Unexpected server response: 503). Retrying automatically at ");
		expect(submission.info).toEndWith(` UTC (attempt 1 of ${totalRetries}).`);
		expect(submission.info).not.toContain("[object");
		expect(autoRetry).toMatchObject({ attempts: 1, reason: "Unexpected server response: 503" });
		const dueAt = new Date(autoRetry!.nextAttemptAt);
		expect(dueAt.getTime() - beforeFirst).toBeGreaterThanOrEqual(BROWSER_OUTAGE_RETRY_DELAYS_MS[0]! - 5_000);
		expect(dueAt.getTime() - beforeFirst).toBeLessThanOrEqual(BROWSER_OUTAGE_RETRY_DELAYS_MS[0]! + 60_000);

		// Not due yet: nothing is started.
		const started: bigint[] = [];
		const startAnalysis = async (options: { submissionId: bigint }) => { started.push(options.submissionId); };
		expect(await runQueuedVisits(startAnalysis)).toEqual([]);
		// Due: re-queued through the normal retry boundary.
		expect(await runQueuedVisits(startAnalysis, { all: true })).toEqual([id]);
		expect(started).toEqual([id]);
		expect((await SubmissionsEntity.get(id))?.status).toBe("running");

		// Subsequent failures follow the progressive schedule until all 24h retries are exhausted.
		for (let attempt = 2; attempt <= totalRetries; attempt++) {
			const before = Date.now();
			await run();
			({ autoRetry } = await autoRetryOf());
			expect(autoRetry?.attempts).toBe(attempt);
			const expectedDelay = BROWSER_OUTAGE_RETRY_DELAYS_MS[attempt - 1]!;
			const actualDelay = new Date(autoRetry!.nextAttemptAt).getTime() - before;
			expect(actualDelay).toBeGreaterThanOrEqual(expectedDelay - 5_000);
			expect(actualDelay).toBeLessThanOrEqual(expectedDelay + 60_000);
		}
		// The last scheduled retry is the visit job's own, as the worker runs it.
		await runQueuedVisits((options) => analyzeWebsite(options, failing), { all: true });
		({ submission, autoRetry } = await autoRetryOf());
		expect(submission.status).toBe("failed");
		expect(submission.info).toBe(`The browser service failed (Unexpected server response: 503). It failed ${totalRetries + 1} times in a row; retry once it has recovered.`);
		expect(autoRetry).toBeUndefined();
		expect(await runQueuedVisits(startAnalysis, { all: true })).toEqual([]);
	});

	test("a due retry the retry boundary refuses, because the case was reported, is dropped instead of being refused on every pass", async () => {
		const id = await websiteSubmission(374703356112802866n, "https://netflix-reported-before.com/");
		await analyzeWebsite({ submissionId: id, url: "https://netflix-reported-before.com/" }, dependencies(archiveOf([hop(0, "https://netflix-reported-before.com/", 200)])));
		const reported = await SubmissionsEntity.get(id);
		expect({ status: reported?.status, info: reported?.info }).toEqual({ status: "reported", info: expect.any(String) });
		// As if a later analysis of the reported case had stopped unfinished.
		const website = (await SubmissionsEntity.get(id))!.data;
		const dueAt = new Date("2026-11-15T01:30:00Z");
		await SubmissionsEntity.update(id, { status: "failed", data: { kind: "website", website: { ...(website.kind === "website" ? website.website : { url: "" }), autoRetry: { attempts: 1, nextAttemptAt: dueAt.toISOString(), reason: "The visit's 8-minute budget ended the walk." } } } });

		const started: bigint[] = [];
		const startAnalysis = async (options: { submissionId: bigint }) => { started.push(options.submissionId); };
		await ensureWebsiteVisitJobs();
		await runQueuedVisits(startAnalysis, { all: true });
		expect(started).toEqual([]);
		const after = await SubmissionsEntity.get(id);
		expect(after?.status).toBe("failed");
		expect(after?.data.kind === "website" ? after.data.website.autoRetry : "none").toBeUndefined();
		expect(await queuedVisits()).toEqual([]);
	});

	test("a site that blocks every egress is final: no backoff and no automatic retry", async () => {
		const id = await websiteSubmission(374703356112802865n, url);
		let attempts = 0;
		await analyzeWebsite({ submissionId: id, url }, {
			...dependencies(archiveOf([hop(0, url, 200)])),
			browserBackoffMs: [1, 1, 1],
			archiveWebsite: async () => {
				attempts++;
				throw new Error('Failed to load page: HTTP 403 ("Attention Required! | Cloudflare") via residential exit; HTTP 403 via Tor exit; HTTP 403 via server IP');
			},
		});
		const submission = (await SubmissionsEntity.get(id))!;
		expect(attempts).toBe(1);
		expect(submission.status).toBe("failed");
		expect(submission.info).toBe('Failed to load page: HTTP 403 ("Attention Required! | Cloudflare") via residential exit; HTTP 403 via Tor exit; HTTP 403 via server IP');
		expect(submission.data.kind === "website" ? submission.data.website.autoRetry : "not website").toBeUndefined();
	});
});
