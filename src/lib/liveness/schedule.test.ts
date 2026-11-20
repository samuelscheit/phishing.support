import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { validateAbuseReportRequest } from "../abuse/contracts";
import { AbuseRepository } from "../abuse/repository";
import { abuseJobs, abuseReports, abuseTargets, type AbuseJob } from "../abuse/schema";
import { AbuseWorker } from "../abuse/worker";
import { saveResolvedTarget } from "../abuse/worker/resolution";
import { getDb } from "../db";
import { useTemporaryDatabase } from "../db/test_helpers";
import { DAY_MS, HOUR_MS } from "../util/date_time";
import type { SiteCheckDependencies } from "./check";
import { listLivenessTargets, listSiteChecks, listSiteChecksForTargets, livenessJobKey, recordSiteCheck } from "./repository";
import { ensureLivenessChecks, LIVENESS_CHECK_OFFSETS_MS, nextLivenessCheckAt, runLivenessCheck, scheduleLivenessChecks } from "./schedule";

useTemporaryDatabase();

const reportedAt = new Date("2026-11-01T12:00:00.000Z");
const after = (ms: number) => new Date(reportedAt.getTime() + ms);

describe("nextLivenessCheckAt", () => {
	test("walks the offsets after the report", () => {
		expect(nextLivenessCheckAt(reportedAt, undefined, reportedAt)).toEqual(after(HOUR_MS));
		expect(nextLivenessCheckAt(reportedAt, after(HOUR_MS + 5_000), after(HOUR_MS + 5_000))).toEqual(after(6 * HOUR_MS));
		expect(nextLivenessCheckAt(reportedAt, after(6 * HOUR_MS), after(6 * HOUR_MS))).toEqual(after(DAY_MS));
		expect(nextLivenessCheckAt(reportedAt, after(DAY_MS), after(DAY_MS))).toEqual(after(3 * DAY_MS));
		expect(nextLivenessCheckAt(reportedAt, after(3 * DAY_MS), after(3 * DAY_MS))).toEqual(after(7 * DAY_MS));
		expect(nextLivenessCheckAt(reportedAt, after(7 * DAY_MS), after(7 * DAY_MS))).toEqual(after(14 * DAY_MS));
		expect(nextLivenessCheckAt(reportedAt, after(14 * DAY_MS), after(14 * DAY_MS))).toEqual(after(30 * DAY_MS));
		expect(nextLivenessCheckAt(reportedAt, after(30 * DAY_MS), after(30 * DAY_MS))).toBeUndefined();
	});

	test("offsets that passed unchecked collapse into one check now", () => {
		const twoDays = after(2 * DAY_MS);
		expect(nextLivenessCheckAt(reportedAt, undefined, twoDays)).toEqual(twoDays);
		expect(nextLivenessCheckAt(reportedAt, twoDays, twoDays)).toEqual(after(3 * DAY_MS));
		// A check delayed past the 14-day offset covers it.
		expect(nextLivenessCheckAt(reportedAt, after(20 * DAY_MS), after(20 * DAY_MS))).toEqual(after(30 * DAY_MS));
	});

	test("a target over a month old and never checked is checked once now and never again", () => {
		const now = after(40 * DAY_MS);
		expect(nextLivenessCheckAt(reportedAt, undefined, now)).toEqual(now);
		expect(nextLivenessCheckAt(reportedAt, now, now)).toBeUndefined();
	});

	test("a check exactly at an offset covers it", () => {
		expect(nextLivenessCheckAt(reportedAt, after(DAY_MS), after(DAY_MS + 1))).toEqual(after(3 * DAY_MS));
		expect(LIVENESS_CHECK_OFFSETS_MS).toEqual([HOUR_MS, 6 * HOUR_MS, DAY_MS, 3 * DAY_MS, 7 * DAY_MS, 14 * DAY_MS, 30 * DAY_MS]);
	});
});

async function createSiteReport(target = "kit-example.com", urls = [`https://login.${target}/verify`]) {
	const request = await validateAbuseReportRequest({
		targets: [target],
		allegationCategory: "phishing",
		description: "A credential-harvesting page impersonates the protected brand.",
		observedUrls: [{ target, urls }],
	});
	const { reportId } = await AbuseRepository.createReport({ request, reporter: {} });
	const [row] = await AbuseRepository.listTargets(reportId);
	const report = (await AbuseRepository.getReport(reportId))!;
	return { reportId, targetId: row!.id, reportedAt: report.createdAt };
}

async function resolve(reportId: bigint, targetId: bigint, status: "resolved" | "no_route" = "resolved") {
	await saveResolvedTarget(reportId, targetId, { status, resolverSnapshot: { source: "liveness_test" }, routes: [] });
}

async function livenessJobs(targetId?: bigint): Promise<AbuseJob[]> {
	const db = await getDb();
	return db.select().from(abuseJobs)
		.where(and(eq(abuseJobs.jobType, "check_site_liveness"), ...(targetId === undefined ? [] : [eq(abuseJobs.dedupeKey, livenessJobKey(targetId))])))
		.all();
}

async function complete(job: AbuseJob) {
	const db = await getDb();
	db.update(abuseJobs).set({ status: "completed" }).where(eq(abuseJobs.id, job.id)).run();
}

async function setReportedAt(reportId: bigint, createdAt: Date) {
	const db = await getDb();
	db.update(abuseReports).set({ createdAt }).where(eq(abuseReports.id, reportId)).run();
}

/** A site that answers every visit with `status`; DNS resolves and RDAP knows no server. */
function siteAnswering(status: number, now: () => Date): SiteCheckDependencies {
	return {
		dns: { resolve4: async () => ["203.0.113.10"], resolve6: async () => [], resolveCname: async () => [] },
		rdap: { rdapLocator: async () => undefined },
		assertPublicHost: async () => undefined,
		fetch: async () => new Response(status === 404 ? "Not Found" : "<html><title>Sign in</title></html>", { status, headers: { "content-type": "text/html" } }),
		now,
	};
}

describe("scheduling a target's checks", () => {
	test("a resolved site target gets its first check an hour after the report, once", async () => {
		const { reportId, targetId, reportedAt: createdAt } = await createSiteReport();
		await resolve(reportId, targetId);
		await resolve(reportId, targetId);
		const jobs = await livenessJobs();
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			jobType: "check_site_liveness",
			reportId,
			status: "queued",
			dedupeKey: `liveness:${targetId.toString()}`,
			payload: { targetId: targetId.toString() },
			nextAttemptAt: new Date(createdAt.getTime() + HOUR_MS),
		});
	});

	test("targets that are no site to visit get no checks", async () => {
		const unrouted = await createSiteReport("unrouted-example.com");
		await resolve(unrouted.reportId, unrouted.targetId, "no_route");

		const db = await getDb();
		const mailbox = await createSiteReport("mailbox-example.com");
		db.update(abuseTargets).set({ targetType: "email" }).where(eq(abuseTargets.id, mailbox.targetId)).run();
		await resolve(mailbox.reportId, mailbox.targetId);

		const withoutUrl = await createSiteReport("nourl-example.com");
		db.update(abuseTargets).set({ observedUrls: [] }).where(eq(abuseTargets.id, withoutUrl.targetId)).run();
		await resolve(withoutUrl.reportId, withoutUrl.targetId);

		const canceled = await createSiteReport("canceled-example.com");
		db.update(abuseReports).set({ status: "canceled" }).where(eq(abuseReports.id, canceled.reportId)).run();
		await resolve(canceled.reportId, canceled.targetId);

		expect(await livenessJobs()).toEqual([]);
		await ensureLivenessChecks();
		expect(await livenessJobs()).toEqual([]);
	});

	test("an IP target is checked like a domain", async () => {
		const { reportId, targetId } = await createSiteReport("45.33.32.156", ["http://45.33.32.156/login.php"]);
		await resolve(reportId, targetId);
		expect(await livenessJobs(targetId)).toHaveLength(1);
		expect((await listLivenessTargets({ targetId }))[0]).toMatchObject({ url: "http://45.33.32.156/login.php" });
	});

	test("several reports of one host are checked each on its own schedule", async () => {
		const first = await createSiteReport();
		const second = await createSiteReport();
		await resolve(first.reportId, first.targetId);
		await resolve(second.reportId, second.targetId);
		expect((await livenessJobs()).map((job) => job.dedupeKey).sort()).toEqual([livenessJobKey(first.targetId), livenessJobKey(second.targetId)].sort());
	});
});

describe("running the checks", () => {
	test("each check is recorded and queues the next until the schedule is done", async () => {
		const { reportId, targetId, reportedAt: createdAt } = await createSiteReport();
		await resolve(reportId, targetId);
		let clock = createdAt;
		const queuedOffsets: number[] = [];
		for (let round = 0; round < LIVENESS_CHECK_OFFSETS_MS.length; round++) {
			const [job] = (await livenessJobs(targetId)).filter((candidate) => candidate.status === "queued");
			expect(job).toBeDefined();
			queuedOffsets.push(job!.nextAttemptAt.getTime() - createdAt.getTime());
			// The check runs a little after it is due.
			clock = new Date(job!.nextAttemptAt.getTime() + 30_000);
			await runLivenessCheck({ jobId: job!.id, targetId, dependencies: siteAnswering(round < 3 ? 200 : 404, () => clock) });
			await complete(job!);
		}
		expect(queuedOffsets).toEqual([...LIVENESS_CHECK_OFFSETS_MS]);
		expect((await livenessJobs(targetId)).filter((job) => job.status === "queued")).toEqual([]);
		const checks = await listSiteChecksForTargets([targetId]);
		expect(checks.map((check) => check.state)).toEqual(["online", "online", "online", "removed", "removed", "removed", "removed"]);
		expect(checks[3]).toMatchObject({ reportId, targetId, url: "https://login.kit-example.com/verify", httpStatus: 404, detail: "HTTP 404.", resolvedAddresses: ["203.0.113.10"] });

		// The schedule is done: nothing is queued again on startup.
		await ensureLivenessChecks();
		expect((await livenessJobs(targetId)).filter((job) => job.status === "queued")).toEqual([]);
	});

	test("a target over a month old and never checked gets exactly one check", async () => {
		const { reportId, targetId } = await createSiteReport();
		await AbuseRepository.setTargetResolution({ targetId, status: "resolved", resolverSnapshot: {} });
		await setReportedAt(reportId, new Date(Date.now() - 40 * DAY_MS));

		const before = Date.now();
		await ensureLivenessChecks();
		const [job] = await livenessJobs(targetId);
		expect(job!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
		expect(job!.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());

		await runLivenessCheck({ jobId: job!.id, targetId, dependencies: siteAnswering(404, () => new Date()) });
		await complete(job!);
		expect(await listSiteChecksForTargets([targetId])).toHaveLength(1);
		expect((await livenessJobs(targetId)).filter((candidate) => candidate.status === "queued")).toEqual([]);
		await ensureLivenessChecks();
		expect((await livenessJobs(targetId)).filter((candidate) => candidate.status === "queued")).toEqual([]);
	});

	test("startup queues each unfinished schedule once and repairs a broken chain", async () => {
		const { reportId, targetId, reportedAt: createdAt } = await createSiteReport();
		await AbuseRepository.setTargetResolution({ targetId, status: "resolved", resolverSnapshot: {} });
		await ensureLivenessChecks();
		await ensureLivenessChecks();
		const [job] = await livenessJobs(targetId);
		expect(await livenessJobs(targetId)).toHaveLength(1);
		expect(job!.nextAttemptAt).toEqual(new Date(createdAt.getTime() + HOUR_MS));

		// The chain broke: its job failed for good after a check at 6 h.
		const db = await getDb();
		db.update(abuseJobs).set({ status: "failed" }).where(eq(abuseJobs.id, job!.id)).run();
		await recordSiteCheck({ reportId, targetId }, {
			url: "https://login.kit-example.com/verify",
			state: "online",
			checkedAt: new Date(createdAt.getTime() + 6 * HOUR_MS),
			resolvedAddresses: [],
			domainStatuses: [],
		});
		await ensureLivenessChecks();
		const queued = (await livenessJobs(targetId)).filter((candidate) => candidate.status === "queued");
		expect(queued).toHaveLength(1);
		expect(queued[0]!.nextAttemptAt).toEqual(new Date(createdAt.getTime() + DAY_MS));
	});

	test("a target that stopped being a site to visit ends its checks", async () => {
		const { reportId, targetId } = await createSiteReport();
		await resolve(reportId, targetId);
		const [job] = await livenessJobs(targetId);
		const db = await getDb();
		db.update(abuseReports).set({ status: "canceled" }).where(eq(abuseReports.id, reportId)).run();
		await runLivenessCheck({ jobId: job!.id, targetId, dependencies: siteAnswering(200, () => new Date()) });
		expect(await listSiteChecks()).toEqual([]);
		expect(await livenessJobs(targetId)).toHaveLength(1);
	});

	test("the worker runs a check in its own lane", async () => {
		const { reportId, targetId } = await createSiteReport();
		await resolve(reportId, targetId);
		const db = await getDb();
		// The report is canceled, so the dispatched check ends without visiting the site.
		db.update(abuseReports).set({ status: "canceled" }).where(eq(abuseReports.id, reportId)).run();
		db.update(abuseJobs).set({ nextAttemptAt: new Date(Date.now() - 1_000) }).where(eq(abuseJobs.dedupeKey, livenessJobKey(targetId))).run();
		const worker = new AbuseWorker();
		expect(await worker.processOne({ jobTypes: ["check_site_liveness"] })).toBe(true);
		expect((await livenessJobs(targetId))[0]).toMatchObject({ status: "completed" });
	});
});

describe("reading the checks", () => {
	test("lists checks grouped by target in the order they were made", async () => {
		const first = await createSiteReport("first-example.com");
		const second = await createSiteReport("second-example.com");
		const [low, high] = [first, second].sort((a, b) => (a.targetId < b.targetId ? -1 : 1));
		const record = (target: typeof low, hours: number, state: "online" | "removed") => recordSiteCheck(target!, {
			url: "https://kit.example/",
			state,
			checkedAt: new Date(reportedAt.getTime() + hours * HOUR_MS),
			resolvedAddresses: ["203.0.113.10"],
			domainStatuses: ["client hold"],
			httpStatus: state === "online" ? 200 : 404,
		});
		await record(high, 6, "removed");
		await record(low, 6, "removed");
		await record(high, 1, "online");
		await record(low, 1, "online");

		const all = await listSiteChecks();
		expect(all.map((check) => [check.targetId, check.state])).toEqual([[low!.targetId, "online"], [low!.targetId, "removed"], [high!.targetId, "online"], [high!.targetId, "removed"]]);
		expect(all[0]).toMatchObject({ resolvedAddresses: ["203.0.113.10"], domainStatuses: ["client hold"], httpStatus: 200, finalUrl: null, detail: null });
		expect((await listSiteChecksForTargets([high!.targetId])).map((check) => check.state)).toEqual(["online", "removed"]);
		expect(await listSiteChecksForTargets([])).toEqual([]);
	});
});
