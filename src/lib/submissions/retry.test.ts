import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { GET as getDetailRoute } from "@/app/api/submissions/[id]/route";
import { GET as getRetriesRoute } from "@/app/api/operator/retries/route";
import { canAnalyzeAgain, retryCountLabel } from "@/app/submissions/[id]/_components/helpers";
import { reportConfirmedWebsiteAbuse } from "../abuse/submission_reports";
import { getDb } from "../db";
import { AnalysisRunsEntity } from "../db/entities/analysis_runs";
import { SubmissionRetriesEntity } from "../db/entities/submission_retries";
import { SubmissionsEntity } from "../db/entities/submissions";
import { submissionRetries, submissions, type SubmissionStatus } from "../db/schema";
import { useTemporaryDatabase } from "../db/test_helpers";
import type { WebsiteRoute } from "../website/types";
import { MANUAL_RETRY_COOLDOWN_MS } from "./retry";
import { listRetryHistory } from "./retry_history";
import { ensureWebsiteVisitJobs } from "../website/visit_queue/run";
import { runQueuedVisits } from "../website/visit_queue/test_helpers";
import { retryWebsiteAnalysis } from "./website";

useTemporaryDatabase();

const URL = "https://trylevo.app/";
const INFO = `No reportable phishing or malware evidence was found at the captured destination ${URL}; no report was created.`;
/** The route of production case 384401854580134038 as it was judged before its copied command was recorded. */
const JUDGED_BENIGN: WebsiteRoute = {
	hops: [{ index: 0, url: URL, hostname: "trylevo.app", status: 200, contentCaptured: true }],
	analyzedHopIndex: 0,
	siteAssessments: [{ hopIndex: 0, judgedHopIndex: 0, finding: "benign" }],
};

async function websiteCase(id: bigint, status: SubmissionStatus, extra: { info?: string; routes?: WebsiteRoute[]; url?: string } = {}) {
	await SubmissionsEntity.create({
		id,
		kind: "website",
		data: { kind: "website", website: { url: extra.url ?? URL, routes: extra.routes } },
		dedupeKey: `retry-${id}`,
		status,
		info: extra.info,
		reporterIp: "203.0.113.77",
		reporterHeaders: { "x-forwarded-for": "203.0.113.77" },
	});
	return id;
}

/** Move a case's retries `ms` (default: a full cooldown) into the past, as if that time had passed. */
async function backdateRetries(submissionId: bigint, ms = MANUAL_RETRY_COOLDOWN_MS) {
	const db = await getDb();
	for (const retry of await SubmissionRetriesEntity.listForSubmission(submissionId)) {
		await db.update(submissionRetries).set({ createdAt: new Date(retry.createdAt.getTime() - ms) }).where(eq(submissionRetries.id, retry.id));
	}
}

/** A fake analysis that records the URLs the queued visits were given. */
function startRecorder() {
	const started: string[] = [];
	return { started, visit: () => runQueuedVisits(async (options) => { started.push(options.url); }) };
}

/** A manual retry, and the visit it queued, run. */
async function retryAndVisit(id: bigint) {
	await retryWebsiteAnalysis(id);
	await runQueuedVisits(async () => undefined);
}

/** The case's automatic retry, scheduled as its failure leaves it, and the visit it queued, run. */
async function retryAutomatically(id: bigint, visit: () => Promise<unknown> = () => runQueuedVisits(async () => undefined)) {
	const submission = await SubmissionsEntity.get(id);
	const website = submission!.data.kind === "website" ? submission!.data.website : undefined;
	const reason = submission!.info ?? "The browser service was unavailable.";
	await SubmissionsEntity.update(id, { data: { kind: "website", website: { ...website!, autoRetry: { attempts: 1, reason, nextAttemptAt: new Date(Date.now() - 1000).toISOString() } } } });
	expect(await ensureWebsiteVisitJobs()).toBe(1);
	await visit();
}

describe("recording retries at the claim", () => {
	test("a manual retry of a case judged not reportable records the status, info and finding it replaces", async () => {
		const id = await websiteCase(1n, "invalid", { info: INFO, routes: [JUDGED_BENIGN] });
		const { started, visit } = startRecorder();
		const before = Date.now();

		await retryWebsiteAnalysis(id);

		// The retry claims the case and queues its visit; the visit starts the analysis.
		expect((await SubmissionsEntity.get(id))?.status).toBe("queued");
		expect(started).toEqual([]);
		await visit();
		expect(started).toEqual([URL]);
		const [retry, ...more] = await SubmissionRetriesEntity.listForSubmission(id);
		expect(more).toEqual([]);
		expect(retry).toMatchObject({ submissionId: id, fromStatus: "invalid", previousInfo: INFO, previousFinding: "benign", trigger: "manual" });
		expect(retry!.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
		expect(typeof retry!.id).toBe("bigint");
	});

	test("an automatic retry is recorded as automatic, with the failure it replaces and no finding when none was made", async () => {
		const reason = "The server restarted during the visit.";
		const id = await websiteCase(2n, "failed", { info: reason });
		await SubmissionsEntity.update(id, { data: { kind: "website", website: { url: URL, autoRetry: { attempts: 1, reason, nextAttemptAt: new Date(Date.now() - 1000).toISOString() } } } });
		const { started, visit } = startRecorder();

		await retryAutomatically(id, visit);

		expect(started).toEqual([URL]);
		expect(await SubmissionRetriesEntity.listForSubmission(id)).toEqual([expect.objectContaining({ fromStatus: "failed", previousInfo: reason, previousFinding: null, trigger: "automatic" })]);
	});

	test("the finding is the headline page's: the analyzed route's analyzed hop, not the first route's or another hop's", async () => {
		const redirector: WebsiteRoute = {
			hops: [
				{ index: 0, url: "https://short.example/x", hostname: "short.example", status: 302, redirectTo: URL, contentCaptured: false },
				{ index: 1, url: URL, hostname: "trylevo.app", status: 200, contentCaptured: true },
			],
			analyzedHopIndex: 1,
			siteAssessments: [{ hopIndex: 0, finding: "insufficient_evidence" }, { hopIndex: 1, judgedHopIndex: 1, finding: "prank_or_troll" }],
		};
		const id = await websiteCase(3n, "invalid", { info: INFO, routes: [JUDGED_BENIGN, redirector] });
		await SubmissionsEntity.update(id, { data: { kind: "website", website: { url: URL, routes: [JUDGED_BENIGN, redirector], analyzedRoute: 1 } } });

		await retryAndVisit(id);

		expect(await SubmissionRetriesEntity.listForSubmission(id)).toEqual([expect.objectContaining({ previousFinding: "prank_or_troll" })]);
	});

	test("refused retries record nothing and leave the case as it was", async () => {
		const { started, visit } = startRecorder();
		const refused = async (id: bigint, message: string) => {
			const before = await SubmissionsEntity.get(id);
			await expect(retryWebsiteAnalysis(id)).rejects.toThrow(message);
			expect(await SubmissionRetriesEntity.listForSubmission(id)).toEqual([]);
			expect((await SubmissionsEntity.get(id))?.status).toBe(before!.status);
		};

		// A run still going: the case is being analyzed.
		const analyzing = await websiteCase(10n, "invalid", { info: INFO });
		await AnalysisRunsEntity.create(analyzing, "analysis");
		await refused(analyzing, "being analyzed or was already reported");

		// A report exists: it may already have reached providers.
		const reportedOnce = await websiteCase(11n, "failed", { url: "http://85.215.226.227/meta/help" });
		await reportConfirmedWebsiteAbuse({ submissionId: reportedOnce, urls: ["http://85.215.226.227/meta/help"], analysisText: "Credential page.", reporter: {}, finding: { finding: "phishing", phishingBasis: "credential_theft" } });
		await refused(reportedOnce, "being analyzed or was already reported");

		// Running or reported cases are no retry candidates at all.
		await refused(await websiteCase(12n, "running"), "Only failed or unreported submissions can be retried.");
		await refused(await websiteCase(13n, "reported"), "Only failed or unreported submissions can be retried.");

		// No source to analyze: refused after validation, before the claim.
		await refused(await websiteCase(14n, "invalid", { url: "" }), "original website URL is unavailable");

		// Another kind's retry of the same id.
		await refused(await (async () => {
			await SubmissionsEntity.create({ id: 15n, kind: "email", data: { kind: "email" }, dedupeKey: "retry-15", status: "invalid" });
			return 15n;
		})(), "Only website submissions can be retried.");

		expect(await visit()).toEqual([]);
		expect(started).toEqual([]);
	});

	test("retries racing for one case start one analysis and record one retry", async () => {
		const id = await websiteCase(20n, "invalid", { info: INFO, routes: [JUDGED_BENIGN] });
		const { started, visit } = startRecorder();

		const outcomes = await Promise.allSettled([
			retryWebsiteAnalysis(id),
			retryWebsiteAnalysis(id),
			retryWebsiteAnalysis(id),
		]);
		await visit();

		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		// A loser finds the case claimed, or, when the winner's retry is already recorded, inside its cooldown.
		for (const outcome of outcomes.filter((candidate) => candidate.status === "rejected")) {
			expect((outcome as PromiseRejectedResult).reason.message).toMatch(/^(This submission is already being retried\.|This case was analyzed again moments ago; .*)$/);
		}
		expect(started).toEqual([URL]);
		expect(await SubmissionRetriesEntity.listForSubmission(id)).toHaveLength(1);
	});

	test("anyone's retry waits out the cooldown after the last retry; the automatic retry does not", async () => {
		const id = await websiteCase(24n, "invalid", { info: INFO, routes: [JUDGED_BENIGN] });
		const { started, visit } = startRecorder();
		await retryWebsiteAnalysis(id);
		await visit();
		await SubmissionsEntity.update(id, { status: "invalid" });

		await expect(retryWebsiteAnalysis(id)).rejects.toThrow(/^This case was analyzed again moments ago; it can be analyzed again from \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/);
		expect((await SubmissionsEntity.get(id))?.status).toBe("invalid");
		expect(await SubmissionRetriesEntity.listForSubmission(id)).toHaveLength(1);
		expect(started).toHaveLength(1);

		// Just before the cooldown ends it still waits; once it ended, the retry starts.
		await backdateRetries(id, MANUAL_RETRY_COOLDOWN_MS - 5_000);
		await expect(retryWebsiteAnalysis(id)).rejects.toThrow("analyzed again moments ago");
		await backdateRetries(id, 5_000);
		await retryWebsiteAnalysis(id);
		await visit();
		expect(started).toHaveLength(2);

		// A browser-service failure is retried on its own backoff, however recent the last retry.
		await SubmissionsEntity.update(id, { status: "failed", info: "Browser service unavailable." });
		await retryAutomatically(id, visit);
		expect(started).toHaveLength(3);
		expect((await SubmissionRetriesEntity.listForSubmission(id)).map(({ trigger }) => trigger)).toEqual(["automatic", "manual", "manual"]);
	});

	test("the claim is taken from the status it was validated at: a case that moved meanwhile is not claimed", async () => {
		const id = await websiteCase(21n, "invalid", { info: INFO });
		// As if another request claimed it and its analysis failed between validation and claim.
		await SubmissionsEntity.update(id, { status: "failed" });
		await expect(SubmissionRetriesEntity.claim({ submissionId: id, from: "invalid", to: "running", trigger: "manual" })).resolves.toBe(false);
		expect((await SubmissionsEntity.get(id))?.status).toBe("failed");
		expect(await SubmissionRetriesEntity.listForSubmission(id)).toEqual([]);
		// An unknown case is never claimed either.
		await expect(SubmissionRetriesEntity.claim({ submissionId: 999n, from: "failed", to: "running", trigger: "manual" })).resolves.toBe(false);
	});

	test("every retry of a case is kept, newest first, and its rows go with the case", async () => {
		const id = await websiteCase(22n, "invalid", { info: INFO, routes: [JUDGED_BENIGN] });
		await retryAndVisit(id);
		await SubmissionsEntity.update(id, { status: "failed", info: "Browser service unavailable." });
		await retryAutomatically(id);

		const retries = await SubmissionRetriesEntity.listForSubmission(id);
		expect(retries.map(({ fromStatus, previousInfo, trigger }) => ({ fromStatus, previousInfo, trigger }))).toEqual([
			{ fromStatus: "failed", previousInfo: "Browser service unavailable.", trigger: "automatic" },
			{ fromStatus: "invalid", previousInfo: INFO, trigger: "manual" },
		]);
		expect(await SubmissionRetriesEntity.summaryForSubmission(id)).toEqual({ count: 2, lastAt: retries[0]!.createdAt });
		expect(await SubmissionRetriesEntity.summaryForSubmission(23n)).toEqual({ count: 0, lastAt: null });

		const db = await getDb();
		await db.delete(submissions).where(eq(submissions.id, id));
		expect(await SubmissionRetriesEntity.listForSubmission(id)).toEqual([]);
	});
});

describe("the public submission detail", () => {
	async function detail(id: bigint) {
		const response = await getDetailRoute(new Request(`http://localhost/api/submissions/${id}`), { params: Promise.resolve({ id: id.toString() }) });
		return { status: response.status, text: await response.text() };
	}

	test("counts the case's retries and names the last, without the reporter's IP", async () => {
		const id = await websiteCase(30n, "invalid", { info: INFO, routes: [JUDGED_BENIGN] });
		expect(JSON.parse((await detail(id)).text).retries).toEqual({ count: 0, lastAt: null });

		await retryAndVisit(id);
		await SubmissionsEntity.update(id, { status: "invalid" });
		await backdateRetries(id);
		await retryAndVisit(id);

		const { status, text } = await detail(id);
		expect(status).toBe(200);
		expect(text).not.toContain("203.0.113.77");
		const body = JSON.parse(text);
		const [last] = await SubmissionRetriesEntity.listForSubmission(id);
		expect(body.retries).toEqual({ count: 2, lastAt: last!.createdAt.toISOString() });
	});
});

describe("the operator's retried cases", () => {
	const PASSWORD = "operator-test-password-0123456789";
	const original = process.env.OPERATOR_PASSWORD;
	beforeAll(() => { process.env.OPERATOR_PASSWORD = PASSWORD; });
	afterAll(() => {
		if (original === undefined) delete process.env.OPERATOR_PASSWORD;
		else process.env.OPERATOR_PASSWORD = original;
	});

	const basic = (password: string) => `Basic ${Buffer.from(`operator:${password}`).toString("base64")}`;
	const list = (authorization?: string) => getRetriesRoute(new Request("http://localhost/api/operator/retries", { headers: authorization ? { authorization } : {} }));

	test("is only given to the operator", async () => {
		await websiteCase(40n, "invalid", { info: INFO });
		await retryAndVisit(40n);

		for (const response of [await list(), await list(basic("wrong-password-0123456789xyz")), await list("Bearer " + PASSWORD)]) {
			expect(response.status).toBe(401);
			expect(response.headers.get("www-authenticate")).toContain("Basic");
			expect(await response.text()).not.toContain("40");
		}
		const allowed = await list(basic(PASSWORD));
		expect(allowed.status).toBe(200);
		expect(allowed.headers.get("cache-control")).toBe("private, no-store");
	});

	test("lists every retry newest first with the case before and now, its trigger and the case's retry count", async () => {
		// Case 50: judged benign, retried by hand, failed, retried automatically, now reported as malware.
		const malware: WebsiteRoute = { ...JUDGED_BENIGN, siteAssessments: [{ hopIndex: 0, judgedHopIndex: 0, finding: "malware", evidenceQuote: "osascript -l JavaScript" }] };
		await websiteCase(50n, "invalid", { info: INFO, routes: [JUDGED_BENIGN] });
		await retryAndVisit(50n);
		await SubmissionsEntity.update(50n, { status: "failed", info: "Browser service unavailable." });
		await retryAutomatically(50n);
		await SubmissionsEntity.update(50n, { status: "reported", info: "Malware distribution confirmed at https://trylevo.app/.", data: { kind: "website", website: { url: URL, routes: [malware] } } });
		// Case 51: an email judged not phishing, retried by hand and still running.
		await SubmissionsEntity.create({ id: 51n, kind: "email", data: { kind: "email", email: { subject: "Your mailbox is full" } as never }, dedupeKey: "retry-51", status: "invalid", reporterIp: "203.0.113.77" });
		await SubmissionRetriesEntity.claim({ submissionId: 51n, from: "invalid", to: "running", trigger: "manual" });
		// A case never retried is not listed.
		await websiteCase(52n, "invalid", { info: INFO });

		const response = await list(basic(PASSWORD));
		const text = await response.text();
		expect(text).not.toContain("203.0.113.77");
		const { retries } = JSON.parse(text);
		expect(retries).toEqual([
			{
				id: expect.any(String), submissionId: "51", kind: "email", target: "Your mailbox is full", trigger: "manual", retriedAt: expect.any(String),
				before: { status: "invalid", info: null, finding: null },
				now: { status: "running", info: null, finding: null },
				caseRetryCount: 1,
			},
			{
				id: expect.any(String), submissionId: "50", kind: "website", target: URL, trigger: "automatic", retriedAt: expect.any(String),
				before: { status: "failed", info: "Browser service unavailable.", finding: "benign" },
				now: { status: "reported", info: "Malware distribution confirmed at https://trylevo.app/.", finding: "malware", reportedAs: "malware" },
				caseRetryCount: 2,
			},
			{
				id: expect.any(String), submissionId: "50", kind: "website", target: URL, trigger: "manual", retriedAt: expect.any(String),
				before: { status: "invalid", info: INFO, finding: "benign" },
				now: { status: "reported", info: "Malware distribution confirmed at https://trylevo.app/.", finding: "malware", reportedAs: "malware" },
				caseRetryCount: 2,
			},
		]);
		expect(retries.map((retry: { retriedAt: string }) => retry.retriedAt)).toEqual([...retries.map((retry: { retriedAt: string }) => retry.retriedAt)].sort().reverse());
		expect(await listRetryHistory(1)).toHaveLength(1);
	});

	test("an email without a subject is named by where it came from", async () => {
		await SubmissionsEntity.create({ id: 60n, kind: "email", data: { kind: "email" }, dedupeKey: "retry-60", status: "failed", source: "imap:INBOX" });
		await SubmissionRetriesEntity.claim({ submissionId: 60n, from: "failed", to: "running", trigger: "manual" });
		expect((await listRetryHistory()).map(({ target }) => target)).toEqual(["imap:INBOX"]);
	});
});

describe("the case page's Analyze again", () => {
	const runs = (...statuses: Array<"running" | "completed" | "failed">) => statuses.map((status) => ({ status })) as never;

	test("is offered for a failed case and for every case judged not reportable, whatever its runs completed", () => {
		for (const status of ["failed", "invalid"] as const) {
			expect(canAnalyzeAgain({ status, analysisRuns: runs() }, 0, true)).toBe(true);
			expect(canAnalyzeAgain({ status, analysisRuns: runs("completed", "completed") }, 0, true)).toBe(true);
			expect(canAnalyzeAgain({ status, analysisRuns: runs("completed", "failed") }, 0, true)).toBe(true);
		}
	});

	test("is not offered while a run goes on, once a report exists, without the source, or for a running or reported case", () => {
		expect(canAnalyzeAgain({ status: "invalid", analysisRuns: runs("completed", "running") }, 0, true)).toBe(false);
		expect(canAnalyzeAgain({ status: "invalid", analysisRuns: runs("completed") }, 1, true)).toBe(false);
		expect(canAnalyzeAgain({ status: "failed", analysisRuns: runs() }, 0, false)).toBe(false);
		expect(canAnalyzeAgain({ status: "running", analysisRuns: runs() }, 0, true)).toBe(false);
		expect(canAnalyzeAgain({ status: "reported", analysisRuns: runs("completed") }, 0, true)).toBe(false);
	});

	test("names how often the case was analyzed again", () => {
		expect(retryCountLabel(0)).toBeUndefined();
		expect(retryCountLabel(1)).toBe("Analyzed again once");
		expect(retryCountLabel(3)).toBe("Analyzed again 3 times");
	});
});
