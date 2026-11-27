import { describe, expect, test } from "bun:test";

import { AnalysisRunsEntity } from "../db/entities/analysis_runs";
import { ArtifactsEntity } from "../db/entities/artifacts";
import { SubmissionsEntity } from "../db/entities/submissions";
import { useTemporaryDatabase } from "../db/test_helpers";
import { reportConfirmedWebsiteAbuse } from "../abuse/submission_reports";
import { getRetryableSubmission } from "./retry";
import type { AnalyzeWebsiteOptions } from "../website/analysis/ai";
import { REPORTER_MHTML_NAME } from "../website/visit_queue/queue";
import { makeQueuedVisitsDue, queuedVisits, runQueuedVisits } from "../website/visit_queue/test_helpers";
import { claimNextJob } from "../abuse/persistence/jobs";
import { jobs } from "../abuse/schema";
import { getDb } from "../db";
import { eq } from "drizzle-orm";
import { createWebsiteSubmission, SubmissionRetryError, retryWebsiteAnalysis, websiteSubmissionUrl } from "./website";

useTemporaryDatabase();

describe("retryWebsiteAnalysis", () => {
	test("rejects a non-website submission before scheduling work", async () => {
		const id = await SubmissionsEntity.create({
			id: 1n,
			kind: "email",
			data: { kind: "email" },
			dedupeKey: "website-retry-email",
			status: "failed",
		});

		await expect(retryWebsiteAnalysis(id)).rejects.toBeInstanceOf(SubmissionRetryError);
		expect((await SubmissionsEntity.get(id))?.status).toBe("failed");
	});

	test("rejects a failed website with no retained URL without claiming it", async () => {
		const id = await SubmissionsEntity.create({
			id: 2n,
			kind: "website",
			data: { kind: "website", website: { url: "" } },
			dedupeKey: "website-retry-no-url",
			status: "failed",
		});

		await expect(retryWebsiteAnalysis(id)).rejects.toThrow("original website URL is unavailable");
		expect((await SubmissionsEntity.get(id))?.status).toBe("failed");
	});

	test("allows a failed classification stage to supersede an earlier completed website stage", async () => {
		const id = await SubmissionsEntity.create({
			id: 3n,
			kind: "website",
			data: { kind: "website", website: { url: "https://example.test" } },
			dedupeKey: "website-retry-latest-stage",
			status: "failed",
		});
		const completedRun = await AnalysisRunsEntity.create(id, "analysis");
		await AnalysisRunsEntity.complete(completedRun);
		const failedRun = await AnalysisRunsEntity.create(id, "analysis");
		await AnalysisRunsEntity.fail(failedRun);

		await expect(getRetryableSubmission(id, "website")).resolves.toMatchObject({
			submission: { id, status: "failed" },
		});
		// A run still going is the case being analyzed: no second analysis beside it.
		await AnalysisRunsEntity.create(id, "analysis");
		await expect(getRetryableSubmission(id, "website")).rejects.toThrow("being analyzed or was already reported");
	});

	test("a website judged not reportable can be analyzed again; a running or reported one cannot", async () => {
		const id = await SubmissionsEntity.create({
			id: 31n,
			kind: "website",
			data: { kind: "website", website: { url: "https://trylevo.app/" } },
			dedupeKey: "website-retry-invalid",
			status: "invalid",
		});
		for (const _stage of ["analysis", "classification"]) await AnalysisRunsEntity.complete(await AnalysisRunsEntity.create(id, "analysis"));
		await expect(getRetryableSubmission(id, "website")).resolves.toMatchObject({ submission: { id, status: "invalid" } });

		await SubmissionsEntity.update(id, { status: "running" });
		await expect(getRetryableSubmission(id, "website")).rejects.toThrow("Only failed or unreported submissions can be retried.");
		await SubmissionsEntity.update(id, { status: "reported" });
		await expect(getRetryableSubmission(id, "website")).rejects.toThrow("Only failed or unreported submissions can be retried.");
	});

	test("a website that failed while handing its finding to reporting stays retryable until a report exists", async () => {
		const id = await SubmissionsEntity.create({
			id: 30n,
			kind: "website",
			data: { kind: "website", website: { url: "http://85.215.226.225/Netflix/Home/login.php" } },
			dedupeKey: "website-retry-report-handoff",
			status: "failed",
		});
		for (const _stage of ["analysis", "classification"]) await AnalysisRunsEntity.complete(await AnalysisRunsEntity.create(id, "analysis"));

		await expect(getRetryableSubmission(id, "website")).resolves.toMatchObject({ submission: { id } });
		await reportConfirmedWebsiteAbuse({ submissionId: id, urls: ["https://85.215.226.225/Netflix/Home/login.php"], analysisText: "Credential page.", reporter: {}, finding: { finding: "phishing", phishingBasis: "credential_theft" } });
		await expect(getRetryableSubmission(id, "website")).rejects.toThrow("cannot be retried");
	});

	test("a capture that showed only a cloaking decoy is fetched again instead of re-analyzing the retained decoy", async () => {
		const url = "https://lookup-lgr.to/en/verification";
		const decoyUrl = "https://www.wikipedia.org/";
		const navigationHops = [
			{ index: 0, url, hostname: "lookup-lgr.to", status: 200, redirectTo: decoyUrl, contentCaptured: false },
			{ index: 1, url: decoyUrl, hostname: "www.wikipedia.org", status: 200, contentCaptured: true },
		];
		const id = await SubmissionsEntity.create({
			id: 40n,
			kind: "website",
			data: { kind: "website", website: { url, archiveUrl: decoyUrl, routes: [{ hops: navigationHops }], cloaking: { outcome: "unresolved", detail: "decoy only" } } },
			dedupeKey: "website-retry-cloaked",
			status: "failed",
		});
		await ArtifactsEntity.saveWebsiteArtifacts({
			submissionId: id,
			archive: { archivedAt: new Date(), mhtml: Buffer.from("From: <Saved by Blink>\r\n\r\n<html></html>"), screenshotPng: Buffer.from("png") },
			evidence: { page: { route: 0, step: 0 }, manifest: Buffer.from("{}") },
		});
		const started: AnalyzeWebsiteOptions[] = [];

		await retryWebsiteAnalysis(id);
		expect(await runQueuedVisits(async (options) => started.push(options))).toEqual([id]);

		expect(started).toHaveLength(1);
		expect(started[0]?.mhtmlSnapshot).toBeUndefined();
		expect(started[0]?.reuseEvidenceArtifacts).toBe(false);
	});

	test("a case judged not reportable is visited again instead of re-judging its retained capture", async () => {
		const url = "https://trylevo.app/";
		const navigationHops = [{ index: 0, url, hostname: "trylevo.app", status: 200, contentCaptured: true }];
		const id = await SubmissionsEntity.create({
			id: 41n,
			kind: "website",
			data: { kind: "website", website: { url, archiveUrl: url, routes: [{ hops: navigationHops }] } },
			dedupeKey: "website-retry-invalid-revisit",
			status: "invalid",
		});
		for (const _stage of ["analysis", "classification"]) await AnalysisRunsEntity.complete(await AnalysisRunsEntity.create(id, "analysis"));
		await ArtifactsEntity.saveWebsiteArtifacts({
			submissionId: id,
			archive: { archivedAt: new Date(), mhtml: Buffer.from("From: <Saved by Blink>\r\n\r\n<html></html>"), screenshotPng: Buffer.from("png") },
			evidence: { page: { route: 0, step: 0 }, manifest: Buffer.from("{}") },
		});
		const started: AnalyzeWebsiteOptions[] = [];

		await retryWebsiteAnalysis(id);
		// The retry is claimed at once and waits for its turn in the visit queue.
		expect((await SubmissionsEntity.get(id))?.status).toBe("queued");
		// The claim is taken once: a second request while it waits is refused, and queues nothing more.
		await expect(retryWebsiteAnalysis(id)).rejects.toThrow("Only failed or unreported submissions can be retried.");
		expect(await queuedVisits()).toHaveLength(1);
		expect(await runQueuedVisits(async (options) => started.push(options))).toEqual([id]);

		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({ url, reuseEvidenceArtifacts: false });
		expect(started[0]?.mhtmlSnapshot).toBeUndefined();
		expect(started[0]?.screenshotSnapshot).toBeUndefined();
	});

	test("a visit the process died in is retried automatically, with its runs failed so the retry is allowed", async () => {
		const id = await SubmissionsEntity.create({
			id: 4n,
			kind: "website",
			data: { kind: "website", website: { url: "https://interrupted.example.test" } },
			dedupeKey: "website-retry-interrupted-run",
			status: "queued",
		});
		await retryVisitJobFor(id);
		const runId = await AnalysisRunsEntity.create(id, "analysis");
		// The analysis took the case and its run, then the process died: the job's lease ran out and it runs again.
		await SubmissionsEntity.update(id, { status: "running" });
		expect(await runQueuedVisits(async () => { throw new Error("a cut-off visit is not visited again at once"); })).toEqual([id]);

		expect(await AnalysisRunsEntity.listForSubmission(id)).toMatchObject([{ id: runId, status: "failed" }]);
		const failed = await SubmissionsEntity.get(id);
		expect(failed?.status).toBe("failed");
		expect(failed?.info).toStartWith("The server restarted during the visit. Retrying automatically at");
		expect(failed?.data.kind === "website" && failed.data.website.autoRetry).toMatchObject({ attempts: 1, reason: "The server restarted during the visit." });
		const [retry] = await queuedVisits();
		expect(retry?.payload).toEqual({ submissionId: id.toString(), trigger: "automatic" });
		expect(retry!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);

		// Not due yet; once its backoff passed, the automatic retry visits the site again.
		expect(await runQueuedVisits(async () => undefined)).toEqual([]);
		const started: string[] = [];
		expect(await runQueuedVisits(async (options) => { started.push(options.url); }, { all: true })).toEqual([id]);
		expect(started).toEqual(["https://interrupted.example.test"]);
		expect((await SubmissionsEntity.get(id))?.status).toBe("running");
	});

	test("a visit cut off again and again ends failed once the retry budget is spent", async () => {
		const id = await SubmissionsEntity.create({
			id: 6n,
			kind: "website",
			data: { kind: "website", website: { url: "https://crashes.example.test" } },
			dedupeKey: "website-retry-crash-loop",
			status: "queued",
		});
		await retryVisitJobFor(id);
		for (let cut = 0; cut < 4; cut++) {
			// Each visit takes the case and its process dies in it: the job's lease runs out.
			await makeQueuedVisitsDue();
			const job = (await claimNextJob("dying-worker", 60_000, { jobTypes: ["visit_website"] }))!;
			await SubmissionsEntity.update(id, { status: "running" });
			(await getDb()).update(jobs).set({ leaseExpiresAt: new Date(Date.now() - 1) }).where(eq(jobs.id, job.id)).run();
			expect(await runQueuedVisits(async () => { throw new Error("a cut-off visit is not visited again at once"); })).toEqual([id]);
		}
		const left = await SubmissionsEntity.get(id);
		expect(left?.status).toBe("failed");
		expect(left?.info).toBe("The server restarted during the visit. It was cut off 4 times; retry to visit the site again.");
		expect(await queuedVisits()).toEqual([]);
	});

	test("a scheduled automatic retry of a case that has since reported is dropped, not visited", async () => {
		const id = await SubmissionsEntity.create({
			id: 5n,
			kind: "website",
			data: { kind: "website", website: { url: "http://85.215.226.226/meta/help", autoRetry: { attempts: 1, nextAttemptAt: new Date().toISOString(), reason: "browser" } } },
			dedupeKey: "website-retry-interrupted-reported",
			status: "failed",
		});
		await reportConfirmedWebsiteAbuse({ submissionId: id, urls: ["http://85.215.226.226/meta/help/"], analysisText: "Credential page.", reporter: {}, finding: { finding: "phishing", phishingBasis: "credential_theft" } });
		const { enqueueWebsiteVisit } = await import("../website/visit_queue/queue");
		await enqueueWebsiteVisit({ submission: (await SubmissionsEntity.get(id))!, trigger: "automatic" });
		const started: string[] = [];
		expect(await runQueuedVisits(async (options) => { started.push(options.url); })).toEqual([id]);
		expect(started).toEqual([]);
		// The refused retry is cleared, so the case shows no retry that will not come.
		const left = await SubmissionsEntity.get(id);
		expect(left?.status).toBe("failed");
		expect(left?.data.kind === "website" && left.data.website.autoRetry).toBeFalsy();
	});

	test("a manual retry replaces a scheduled automatic one and runs now", async () => {
		const id = await SubmissionsEntity.create({
			id: 7n,
			kind: "website",
			data: { kind: "website", website: { url: "https://later.example.test" } },
			dedupeKey: "website-retry-replaces-automatic",
			status: "failed",
		});
		const { failWebsiteAnalysis } = await import("../website/analysis/failure");
		await failWebsiteAnalysis(id, { info: "The browser service failed.", retry: { attempts: 0, reason: "relay", exhausted: () => "" } });
		expect((await queuedVisits()).map((job) => job.payload?.trigger)).toEqual(["automatic"]);

		await retryWebsiteAnalysis(id);
		const [job] = await queuedVisits();
		expect(job?.payload).toEqual({ submissionId: id.toString(), trigger: "manual", fromStatus: "failed" });
		expect(job!.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
		const started: string[] = [];
		expect(await runQueuedVisits(async (options) => { started.push(options.url); })).toEqual([id]);
		expect(started).toEqual(["https://later.example.test"]);
	});
});

/** Queue a visit for a case made directly in the table, as `createWebsiteSubmission` would. */
async function retryVisitJobFor(id: bigint) {
	const { enqueueWebsiteVisit } = await import("../website/visit_queue/queue");
	await enqueueWebsiteVisit({ submission: (await SubmissionsEntity.get(id))!, trigger: "initial" });
}

describe("createWebsiteSubmission", () => {
	test("opens a queued case and queues its visit; nothing is visited until the queue runs it", async () => {
		const started: AnalyzeWebsiteOptions[] = [];
		const created = await createWebsiteSubmission({ url: "https://kit.example/login", instructions: { text: "Use the code 1234." } as never, reporterIp: "5.189.203.86" });
		expect(created.status).toBe("queued");
		expect((await SubmissionsEntity.get(created.id))?.status).toBe("queued");
		const [job] = await queuedVisits();
		expect(job).toMatchObject({ jobType: "visit_website", fairKey: "ip:5.189.203.86", serialKey: `visit:${created.id}`, reportId: null, payload: { submissionId: created.id.toString(), trigger: "initial" } });

		expect(await runQueuedVisits(async (options) => started.push(options))).toEqual([created.id]);
		expect(started).toEqual([expect.objectContaining({ submissionId: created.id, url: "https://kit.example/login", reporterIp: "5.189.203.86", instructions: { text: "Use the code 1234." } })]);
		// A finished visit's job is not run again.
		expect(await runQueuedVisits(async (options) => started.push(options))).toEqual([]);
	});

	test("an MHTML the reporter sent along is kept with the case and reaches its visit", async () => {
		const mhtml = Buffer.from("From: <Saved by Blink>\r\n\r\n<html>kit</html>");
		const { id } = await createWebsiteSubmission({ url: "https://kit-upload.example/", mhtmlSnapshot: mhtml });
		expect((await ArtifactsEntity.listForSubmission(id)).map((artifact) => artifact.name)).toEqual([REPORTER_MHTML_NAME]);
		const started: AnalyzeWebsiteOptions[] = [];
		await runQueuedVisits(async (options) => started.push(options));
		expect(started[0]?.mhtmlSnapshot?.toString()).toBe(mhtml.toString());
	});

	test("a case opened for another case's sake counts against the share it was given; a reporter without an address against its source's", async () => {
		const derived = await createWebsiteSubmission({ url: "https://sibling.example/", source: "kit-sibling:1:2", fairKey: "ip:203.0.113.9" });
		const mailed = await createWebsiteSubmission({ url: "https://mailed.example/", source: "email:77" });
		expect((await queuedVisits()).map((job) => [BigInt(String(job.payload?.submissionId)), job.fairKey])).toEqual([[derived.id, "ip:203.0.113.9"], [mailed.id, "source:email"]]);
	});

	test("a pasted blob: address is analyzed as the site that served it, keeping what the reporter pasted as the source", async () => {
		const pasted = "blob:https://6996419621491608.9262480229243856756051631876451bau3amzwa.workers.dev/5c83e339-d1c5-4d0b-95ab-8064e20dfcda";
		const started: string[] = [];

		const { id } = await createWebsiteSubmission({ url: pasted });
		await runQueuedVisits(async ({ url }) => { started.push(url); });

		const site = "https://6996419621491608.9262480229243856756051631876451bau3amzwa.workers.dev/";
		expect(started).toEqual([site]);
		const submission = await SubmissionsEntity.get(id);
		expect(submission?.data).toEqual({ kind: "website", website: { url: site } });
		expect(submission?.source).toBe(pasted);
	});

	test("a site that already has a case keeps it, unless the reporter re-reports it, which opens and analyzes a fresh case each time", async () => {
		const started: bigint[] = [];
		const analyze = async ({ submissionId }: { submissionId: bigint }) => { started.push(submissionId); };
		const { id: original } = await createWebsiteSubmission({ url: "https://kit.example/login" });
		await runQueuedVisits(analyze);
		await SubmissionsEntity.update(original, { status: "reported" });

		expect(await createWebsiteSubmission({ url: "https://kit.example/other" })).toEqual({ id: original, status: "reported" });
		expect((await createWebsiteSubmission({ url: "https://kit.example/login", rereport: false })).id).toBe(original);

		const first = (await createWebsiteSubmission({ url: "https://kit.example/login", rereport: true })).id;
		const second = (await createWebsiteSubmission({ url: "https://kit.example/login", rereport: true })).id;
		await runQueuedVisits(analyze);
		expect(new Set([original, first, second]).size).toBe(3);
		expect(started).toEqual([original, first, second]);
		expect((await SubmissionsEntity.get(first))?.dedupeKey).toBe(`website-kit.example#rereport-${first.toString()}`);
		expect((await SubmissionsEntity.get(original))?.status).toBe("reported");
		// A later ordinary report still lands on the site's original case.
		expect((await createWebsiteSubmission({ url: "https://kit.example/" })).id).toBe(original);
		expect(await queuedVisits()).toEqual([]);
	});

	test("ordinary page addresses are kept as submitted", () => {
		expect(websiteSubmissionUrl(" https://kit.example/c2222120?x=1 ")).toBe("https://kit.example/c2222120?x=1");
		expect(websiteSubmissionUrl("http://85.215.226.225/Netflix/Home/login.php")).toBe("http://85.215.226.225/Netflix/Home/login.php");
		expect(() => websiteSubmissionUrl("not a url")).toThrow();
	});
});
