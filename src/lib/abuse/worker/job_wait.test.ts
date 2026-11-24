import { describe, expect, test } from "bun:test";
import { and, eq, ne } from "drizzle-orm";

import { getDb } from "../../db";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { BrowserUnavailableError } from "../../browser/fabric";
import { validateAbuseReportRequest } from "../contracts";
import { BrowserFormError } from "../providers/kit/browser_form";
import { ProviderSubmissionRetryLaterError } from "../providers/submission_contracts";
import { ProviderLoginError } from "../providers/login_session/session";
import { AbuseRepository } from "../repository";
import { abuseEvents, abuseJobs, type AbuseJobType } from "../schema";
import { AbuseWorker } from "./index";
import { JOB_WAIT_LIMIT_MS, browserWaitDelayMs, MAX_RETRIES } from "./retry";

useTemporaryDatabase();

const HOUR = 3_600_000;
const relayFull = () => new BrowserUnavailableError(new Error("connectOverCDP: WebSocket error: 503 Service Unavailable"));
/** The wrappers the providers put around a missing browser, as they reach the worker. */
const WRAPPED: Record<string, () => Error> = {
	bare: relayFull,
	"browser form": () => new BrowserFormError("browser", "GoDaddy: no browser was available", { cause: relayFull() }),
	login: () => new ProviderLoginError("Cloudflare dashboard", "no browser was available", { cause: relayFull() }),
};

let sequence = 0;

/** A provider-submission route whose run is `starting` (claimed, before its marker), and a job of `jobType` for it. */
async function routeWithJob(jobType: AbuseJobType, routeStatus: "running" | "submitted" = "running") {
	sequence += 1;
	const target_ = `browser-wait-${sequence}.example.com`;
	const request = await validateAbuseReportRequest({
		targets: [target_],
		allegationCategory: "phishing",
		description: "A credential-harvesting page impersonates the protected brand.",
		observedUrls: [{ target: target_, urls: [`https://${target_}/login`] }],
	});
	const created = await AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } });
	const [target] = await AbuseRepository.listTargets(created.reportId);
	const route = await AbuseRepository.upsertResolvedRoute(target!.id, {
		routeKey: `provider:godaddy:${sequence}`,
		providerRegistryKey: "godaddy",
		providerDisplayName: "GoDaddy",
		routeType: "provider_submission",
		resolverProvenance: { source: "browser_unavailable_test" },
		resolutionSnapshot: { source: "test" },
		status: "queued",
	});
	const execution = await AbuseRepository.beginProviderExecution({
		routeId: route.id,
		correlationKey: `provider-submission:godaddy:${route.id.toString()}`,
		providerPayload: { draft: true },
		expectedStatus: "queued",
	});
	if (!execution) throw new Error("Test route could not be claimed.");
	if (routeStatus === "submitted") {
		await AbuseRepository.settleProviderRun({ runId: execution.run.id, executionStatus: "completed", routeStatus: "submitted", confirmationId: "C-1" });
	}
	const job = await AbuseRepository.enqueueJob({ jobType, reportId: created.reportId, routeId: route.id, payload: {} });
	return { reportId: created.reportId, route, run: execution.run, job };
}

async function jobRow(id: bigint) {
	const db = await getDb();
	return db.select().from(abuseJobs).where(eq(abuseJobs.id, id)).get()!;
}

async function setJob(id: bigint, values: Partial<typeof abuseJobs.$inferInsert>) {
	const db = await getDb();
	db.update(abuseJobs).set(values).where(eq(abuseJobs.id, id)).run();
}

/** Run exactly this job once, its handler failing with `error`. */
async function failOnce(jobId: bigint, error: () => unknown) {
	const db = await getDb();
	// Only this job is due: every other queued one waits.
	db.update(abuseJobs).set({ nextAttemptAt: new Date(Date.now() + 365 * 24 * HOUR) }).where(and(eq(abuseJobs.status, "queued"), ne(abuseJobs.id, jobId))).run();
	await setJob(jobId, { nextAttemptAt: new Date(0) });
	const worker = new AbuseWorker({ owner: `browser-wait-${jobId.toString()}`, processJob: async (job) => {
		if (job.id !== jobId) throw new Error(`unexpected job ${job.id.toString()}`);
		throw error();
	} });
	expect(await worker.processOne()).toBeTrue();
}

describe("a job that finds no browser", () => {
	for (const [kind, error] of Object.entries(WRAPPED)) {
		test(`is deferred without spending an attempt (${kind})`, async () => {
			const { job, route, run } = await routeWithJob("submit_provider");
			await setJob(job.id, { retryCount: 3 });
			const before = Date.now();
			await failOnce(job.id, error);
			const after = await jobRow(job.id);
			expect(after).toMatchObject({ status: "queued", retryCount: 3, leaseOwner: null });
			expect(after.lastError).toContain("no browser was available");
			// A fresh job waits the minimum of one minute.
			expect(after.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
			expect(after.nextAttemptAt.getTime()).toBeLessThan(Date.now() + 61_000);
			expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "running" });
			expect(await AbuseRepository.getProviderRun(run.id)).toMatchObject({ executionStatus: "starting" });
			const db = await getDb();
			const events = db.select().from(abuseEvents).where(eq(abuseEvents.jobId, job.id)).all().map((event) => event.eventType);
			expect(events).toContain("job.deferred");
			expect(events).not.toContain("job.retried");
		});
	}

	test("keeps being deferred past MAX_RETRIES deferrals, with an attempt budget left untouched", async () => {
		const { job, route } = await routeWithJob("submit_provider");
		for (let deferral = 0; deferral < MAX_RETRIES + 3; deferral++) await failOnce(job.id, WRAPPED.login!);
		expect(await jobRow(job.id)).toMatchObject({ status: "queued", retryCount: 0 });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "running" });
	});

	test("is deferred even when its attempts are already spent by other failures", async () => {
		const { job, route } = await routeWithJob("submit_provider");
		await setJob(job.id, { retryCount: MAX_RETRIES });
		await failOnce(job.id, relayFull);
		expect(await jobRow(job.id)).toMatchObject({ status: "queued", retryCount: MAX_RETRIES });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "running" });
	});

	test("waits longer the longer it has waited, at most 15 minutes", async () => {
		const { job } = await routeWithJob("submit_provider");
		await setJob(job.id, { createdAt: new Date(Date.now() - 2 * HOUR) });
		const before = Date.now();
		await failOnce(job.id, relayFull);
		const delay = (await jobRow(job.id)).nextAttemptAt.getTime() - before;
		expect(delay).toBeGreaterThanOrEqual(15 * 60_000 - 1_000);
		expect(delay).toBeLessThanOrEqual(15 * 60_000 + 1_000);
		expect(browserWaitDelayMs(0)).toBe(60_000);
		expect(browserWaitDelayMs(8 * 60_000)).toBe(120_000);
		expect(browserWaitDelayMs(20 * HOUR)).toBe(15 * 60_000);
	});

	test("goes to a person after the wait limit: a submission's route is needs_human, never failed, and its run settles failed", async () => {
		const { job, route, run, reportId } = await routeWithJob("submit_provider");
		await setJob(job.id, { createdAt: new Date(Date.now() - JOB_WAIT_LIMIT_MS - 1_000) });
		await failOnce(job.id, WRAPPED["browser form"]!);
		const failed = await jobRow(job.id);
		expect(failed).toMatchObject({ status: "failed", retryCount: 0 });
		expect(failed.lastError).toContain("No browser for 24 h; a person must decide.");
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "needs_human" });
		expect(await AbuseRepository.getProviderRun(run.id)).toMatchObject({ executionStatus: "failed" });
		const db = await getDb();
		const change = db.select().from(abuseEvents).where(eq(abuseEvents.routeId, route.id)).all()
			.find((event) => event.eventType === "route.status_changed" && (event.data as { to?: string }).to === "needs_human");
		expect(change?.data).toMatchObject({ from: "running", to: "needs_human", reason: "browser_unavailable" });
		expect((await AbuseRepository.getReport(reportId))?.status).not.toBe("failed");
	});

	test("a correspondence poll of a submitted report fails alone after the limit: the submitted route stays submitted", async () => {
		const { job, route } = await routeWithJob("poll_provider_correspondence", "submitted");
		await failOnce(job.id, WRAPPED.login!);
		expect(await jobRow(job.id)).toMatchObject({ status: "queued", retryCount: 0 });
		await setJob(job.id, { createdAt: new Date(Date.now() - JOB_WAIT_LIMIT_MS) });
		await failOnce(job.id, WRAPPED.login!);
		expect(await jobRow(job.id)).toMatchObject({ status: "failed" });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "submitted" });
	});

	test("a provider's limit is waited out the same way, as long as the provider asks, at most an hour per wait", async () => {
		const { job, route, run } = await routeWithJob("submit_provider");
		const limit = (retryAfterMs: number) => () => new ProviderSubmissionRetryLaterError("AWS refused the report at its limit (HTTP 429), to be filed later", retryAfterMs);
		for (const [asked, expected] of [[30 * 60_000, 30 * 60_000], [5 * HOUR, HOUR], [0, 60_000]] as const) {
			const before = Date.now();
			await failOnce(job.id, limit(asked));
			const after = await jobRow(job.id);
			expect(after).toMatchObject({ status: "queued", retryCount: 0 });
			expect(after.nextAttemptAt.getTime() - before).toBeGreaterThanOrEqual(expected - 1_000);
			expect(after.nextAttemptAt.getTime() - before).toBeLessThanOrEqual(expected + 1_000);
		}
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "running" });
		expect(await AbuseRepository.getProviderRun(run.id)).toMatchObject({ executionStatus: "starting" });

		await setJob(job.id, { createdAt: new Date(Date.now() - JOB_WAIT_LIMIT_MS - 1_000) });
		await failOnce(job.id, limit(60_000));
		expect((await jobRow(job.id)).lastError).toContain("The provider kept refusing the report at its limit for 24 h; a person must decide.");
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "needs_human" });
	});

	test("any other error still spends attempts and fails the route once they are spent", async () => {
		const { job, route } = await routeWithJob("submit_provider");
		await failOnce(job.id, () => new Error("no browser was available (but untyped)"));
		expect(await jobRow(job.id)).toMatchObject({ status: "queued", retryCount: 1 });
		await setJob(job.id, { retryCount: MAX_RETRIES });
		await failOnce(job.id, () => new Error("provider down"));
		expect(await jobRow(job.id)).toMatchObject({ status: "failed" });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "failed" });
	});
});
