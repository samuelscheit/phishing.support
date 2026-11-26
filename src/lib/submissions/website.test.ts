import { describe, expect, test } from "bun:test";

import { AnalysisRunsEntity } from "../db/entities/analysis_runs";
import { ArtifactsEntity } from "../db/entities/artifacts";
import { SubmissionsEntity } from "../db/entities/submissions";
import { useTemporaryDatabase } from "../db/test_helpers";
import { reportConfirmedWebsiteAbuse } from "../abuse/submission_reports";
import { getRetryableSubmission } from "./retry";
import { retryInterruptedWebsiteAnalysis } from "../website/analysis/ai";
import { createWebsiteSubmission, runDueWebsiteAutoRetries, SubmissionRetryError, retryWebsiteAnalysis, websiteSubmissionUrl } from "./website";

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
		const started: Array<{ mhtmlSnapshot?: Buffer; reuseEvidenceArtifacts?: boolean }> = [];

		await retryWebsiteAnalysis(id, { startAnalysis: async (options) => started.push(options) });

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
		const started: Array<{ url: string; mhtmlSnapshot?: Buffer; screenshotSnapshot?: Buffer; reuseEvidenceArtifacts?: boolean }> = [];

		await retryWebsiteAnalysis(id, { startAnalysis: async (options) => started.push(options) });

		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({ url, reuseEvidenceArtifacts: false });
		expect(started[0]?.mhtmlSnapshot).toBeUndefined();
		expect(started[0]?.screenshotSnapshot).toBeUndefined();
		expect((await SubmissionsEntity.get(id))?.status).toBe("running");
		// The claim is taken once: a second request while it runs is refused.
		await expect(retryWebsiteAnalysis(id, { startAnalysis: async (options) => started.push(options) })).rejects.toThrow("Only failed or unreported submissions can be retried.");
		expect(started).toHaveLength(1);
	});

	test("marks interrupted running analysis runs as failed on startup so the submission remains retryable", async () => {
		const id = await SubmissionsEntity.create({
			id: 4n,
			kind: "website",
			data: { kind: "website", website: { url: "https://interrupted.example.test" } },
			dedupeKey: "website-retry-interrupted-run",
			status: "running",
		});
		const runId = await AnalysisRunsEntity.create(id, "analysis");

		await expect(SubmissionsEntity.failAllRunning()).resolves.toEqual([{ id }]);

		const runs = await AnalysisRunsEntity.listForSubmission(id);
		expect(runs).toMatchObject([{ id: runId, status: "failed" }]);
		await expect(getRetryableSubmission(id, "website")).resolves.toMatchObject({
			submission: { id, status: "failed" },
		});

		// A restart's cut-off visit is due for the automatic retry, which visits the site again.
		await retryInterruptedWebsiteAnalysis(id);
		const queued = await SubmissionsEntity.get(id);
		expect(queued?.info).toStartWith("The server restarted during the visit. Retrying automatically at");
		expect(queued?.data.kind === "website" && queued.data.website.autoRetry).toMatchObject({ attempts: 1, reason: "The server restarted during the visit." });
		expect(await SubmissionsEntity.listDueWebsiteAutoRetries(new Date(Date.now() + 11 * 60_000))).toEqual([{ id }]);
		const started: string[] = [];
		await expect(runDueWebsiteAutoRetries({ now: new Date(Date.now() + 11 * 60_000), startAnalysis: async (options) => { started.push(options.url); } })).resolves.toBe(1);
		expect(started).toEqual(["https://interrupted.example.test"]);
	});

	test("a restart's cut-off visit of a case that already reported is not visited again", async () => {
		const id = await SubmissionsEntity.create({
			id: 5n,
			kind: "website",
			data: { kind: "website", website: { url: "http://85.215.226.226/meta/help" } },
			dedupeKey: "website-retry-interrupted-reported",
			status: "failed",
		});
		await reportConfirmedWebsiteAbuse({ submissionId: id, urls: ["http://85.215.226.226/meta/help/"], analysisText: "Credential page.", reporter: {}, finding: { finding: "phishing", phishingBasis: "credential_theft" } });
		await retryInterruptedWebsiteAnalysis(id);
		const started: string[] = [];
		await expect(runDueWebsiteAutoRetries({ now: new Date(Date.now() + 11 * 60_000), startAnalysis: async (options) => { started.push(options.url); } })).resolves.toBe(0);
		expect(started).toEqual([]);
		// The refused retry is cleared, so it takes no sweep slot again.
		const left = await SubmissionsEntity.get(id);
		expect(left?.status).toBe("failed");
		expect(left?.data.kind === "website" && left.data.website.autoRetry).toBeFalsy();
	});
});

describe("createWebsiteSubmission", () => {
	test("a pasted blob: address is analyzed as the site that served it, keeping what the reporter pasted as the source", async () => {
		const pasted = "blob:https://6996419621491608.9262480229243856756051631876451bau3amzwa.workers.dev/5c83e339-d1c5-4d0b-95ab-8064e20dfcda";
		const started: string[] = [];

		const id = await createWebsiteSubmission({ url: pasted }, async ({ url }) => { started.push(url); });

		const site = "https://6996419621491608.9262480229243856756051631876451bau3amzwa.workers.dev/";
		expect(started).toEqual([site]);
		const submission = await SubmissionsEntity.get(id);
		expect(submission?.data).toEqual({ kind: "website", website: { url: site } });
		expect(submission?.source).toBe(pasted);
	});

	test("a site that already has a case keeps it, unless the reporter re-reports it, which opens and analyzes a fresh case each time", async () => {
		const started: bigint[] = [];
		const analyze = async ({ submissionId }: { submissionId: bigint }) => { started.push(submissionId); };
		const original = await createWebsiteSubmission({ url: "https://kit.example/login" }, analyze);
		await SubmissionsEntity.update(original, { status: "reported" });

		expect(await createWebsiteSubmission({ url: "https://kit.example/other" }, analyze)).toBe(original);
		expect(await createWebsiteSubmission({ url: "https://kit.example/login", rereport: false }, analyze)).toBe(original);

		const first = await createWebsiteSubmission({ url: "https://kit.example/login", rereport: true }, analyze);
		const second = await createWebsiteSubmission({ url: "https://kit.example/login", rereport: true }, analyze);
		expect(new Set([original, first, second]).size).toBe(3);
		expect(started).toEqual([original, first, second]);
		expect((await SubmissionsEntity.get(first))?.dedupeKey).toBe(`website-kit.example#rereport-${first.toString()}`);
		expect((await SubmissionsEntity.get(original))?.status).toBe("reported");
		// A later ordinary report still lands on the site's original case.
		expect(await createWebsiteSubmission({ url: "https://kit.example/" }, analyze)).toBe(original);
	});

	test("ordinary page addresses are kept as submitted", () => {
		expect(websiteSubmissionUrl(" https://kit.example/c2222120?x=1 ")).toBe("https://kit.example/c2222120?x=1");
		expect(websiteSubmissionUrl("http://85.215.226.225/Netflix/Home/login.php")).toBe("http://85.215.226.225/Netflix/Home/login.php");
		expect(() => websiteSubmissionUrl("not a url")).toThrow();
	});
});
