import { describe, expect, test } from "bun:test";

import { and, eq } from "drizzle-orm";

import { claimNextJob, completeJob } from "@/lib/abuse/persistence/jobs";
import { jobs } from "@/lib/abuse/schema";
import { getDb } from "@/lib/db";
import { backfillSiteGroups } from "./site_group";
import { laneFilter } from "@/lib/abuse/worker/jobs";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import { useTemporaryDatabase } from "@/lib/db/test_helpers";
import { createWebsiteSubmission } from "@/lib/submissions/website";
import { claimRetry } from "@/lib/submissions/retry";
import { SubmissionRetriesEntity } from "@/lib/db/entities/submission_retries";
import { enqueueWebsiteVisit, fairKeyOf } from "./queue";
import { ensureWebsiteVisitJobs, runWebsiteVisit } from "./run";
import { queuedVisits, runQueuedVisits } from "./test_helpers";

useTemporaryDatabase();

const website = (id: bigint, status: "queued" | "running" | "failed" | "reported" | "invalid", extra: Record<string, unknown> = {}) => SubmissionsEntity.create({
	id,
	kind: "website",
	data: { kind: "website", website: { url: `https://case-${id}.example/`, ...extra } },
	dedupeKey: `website-case-${id}.example`,
	status,
	reporterIp: "198.51.100.7",
});

describe("the visit lane", () => {
	test("shares its slots between reporters and always keeps one free of a flood", async () => {
		const lane = laneFilter("visit", 4);
		expect(lane).toEqual({ jobTypes: ["visit_website"], fairShare: { perKeyLimit: 3 } });
		expect(laneFilter("visit", 1).fairShare).toEqual({ perKeyLimit: 1 });
		for (let index = 0; index < 100; index++) await createWebsiteSubmission({ url: `https://kit-${index}.example/`, reporterIp: "5.189.203.86" });
		const flood = await Promise.all([1, 2, 3, 4].map(() => claimNextJob("worker", 60_000, lane)));
		expect(flood.map((job) => job?.fairKey)).toEqual(["ip:5.189.203.86", "ip:5.189.203.86", "ip:5.189.203.86", undefined]);
		// Another reporter's URL, submitted after the 100, takes the free slot at once.
		const other = await createWebsiteSubmission({ url: "https://other.example/", reporterIp: "192.0.2.1" });
		expect((await claimNextJob("worker", 60_000, lane))?.payload).toEqual({ submissionId: other.id.toString(), trigger: "initial" });
	});
});

describe("the visits of one site group", () => {
	test("run one after another, never side by side, while other groups go on", async () => {
		const lane = laneFilter("visit", 4);
		const hosts = [];
		for (const host of ["a.slon10.to", "b.slon10.to", "c.b.slon10.to"]) hosts.push(await createWebsiteSubmission({ url: `https://${host}/`, reporterIp: "5.189.203.86" }));
		const tenantA = await createWebsiteSubmission({ url: "https://one.pages.dev/", reporterIp: "5.189.203.86" });
		const tenantB = await createWebsiteSubmission({ url: "https://two.pages.dev/", reporterIp: "192.0.2.1" });
		const claimed = async () => String((await claimNextJob("worker", 60_000, lane))?.payload?.submissionId ?? "none");
		expect([await claimed(), await claimed(), await claimed(), await claimed()]).toEqual([hosts[0]!.id.toString(), tenantB.id.toString(), tenantA.id.toString(), "none"]);
		expect((await queuedVisits()).map((job) => job.serialKey)).toEqual(["site:slon10.to", "site:slon10.to"]);
		// The group's visit ends; the next host of the group is visited.
		const [running] = (await getDb()).select().from(jobs).where(and(eq(jobs.status, "running"), eq(jobs.serialKey, "site:slon10.to"))).all();
		await completeJob(running!.id, "worker");
		expect(await claimed()).toBe(hosts[1]!.id.toString());
		expect(await claimed()).toBe("none");
	});
});

describe("backfillSiteGroups", () => {
	test("gives older website cases their group once, and leaves emails and unparsable URLs alone", async () => {
		await website(1n, "reported");
		await SubmissionsEntity.create({ id: 2n, kind: "website", data: { kind: "website", website: { url: "https://x.y.slon10.to/a" } }, dedupeKey: "website-x.y.slon10.to", status: "failed" });
		await SubmissionsEntity.create({ id: 3n, kind: "website", data: { kind: "website", website: { url: "" } }, dedupeKey: "website-broken", status: "failed" });
		await SubmissionsEntity.create({ id: 4n, kind: "email", data: { kind: "email" }, dedupeKey: "email-4", status: "reported" });
		expect(await backfillSiteGroups()).toBe(2);
		expect(await backfillSiteGroups()).toBe(0);
		expect(await Promise.all([1n, 2n, 3n, 4n].map(async (id) => (await SubmissionsEntity.get(id))?.siteGroup))).toEqual(["case-1.example", "slon10.to", null, null]);
	});
});

describe("ensureWebsiteVisitJobs", () => {
	test("gives every case waiting for a visit its job once, and leaves settled cases alone", async () => {
		await website(1n, "queued");
		await website(2n, "running");
		const retryAt = new Date(Date.now() + 30 * 60_000);
		await website(3n, "failed", { autoRetry: { attempts: 1, nextAttemptAt: retryAt.toISOString(), reason: "relay full" } });
		await website(4n, "failed");
		await website(5n, "reported");
		await website(6n, "invalid");
		await SubmissionsEntity.create({ id: 7n, kind: "email", data: { kind: "email" }, dedupeKey: "email-7", status: "running" });
		const withJob = await website(8n, "queued");
		await enqueueWebsiteVisit({ submission: (await SubmissionsEntity.get(withJob))!, trigger: "manual", fromStatus: "invalid" });

		expect(await ensureWebsiteVisitJobs()).toBe(3);
		expect(await ensureWebsiteVisitJobs()).toBe(0);
		const byCase = new Map((await queuedVisits()).map((job) => [String(job.payload?.submissionId), job]));
		expect([...byCase.keys()].sort()).toEqual(["1", "2", "3", "8"]);
		expect(byCase.get("1")).toMatchObject({ payload: { trigger: "initial" }, fairKey: "ip:198.51.100.7" });
		expect(byCase.get("3")).toMatchObject({ payload: { trigger: "automatic" }, nextAttemptAt: retryAt });
		// The job a case already had is kept as it was.
		expect(byCase.get("8")?.payload).toEqual({ submissionId: "8", trigger: "manual", fromStatus: "invalid" });
	});

	test("a case the last process died in mid-visit is failed with its automatic retry, never left running", async () => {
		await website(2n, "running");
		await ensureWebsiteVisitJobs();
		expect(await runQueuedVisits(async () => { throw new Error("not visited at once"); })).toEqual([2n]);
		const failed = await SubmissionsEntity.get(2n);
		expect(failed).toMatchObject({ status: "failed" });
		expect(failed?.info).toStartWith("The server restarted during the visit. Retrying automatically at");
		expect((await queuedVisits()).map((job) => job.payload?.trigger)).toEqual(["automatic"]);
	});
});

describe("runWebsiteVisit", () => {
	test("a job whose case is gone, settled, or no longer waiting for it does nothing", async () => {
		const analyze = async () => { throw new Error("must not visit"); };
		await runWebsiteVisit({ payload: { submissionId: "404", trigger: "initial" } }, { analyzeWebsite: analyze });
		await website(5n, "reported");
		await runWebsiteVisit({ payload: { submissionId: "5", trigger: "initial" } }, { analyzeWebsite: analyze });
		await runWebsiteVisit({ payload: { submissionId: "5", trigger: "manual", fromStatus: "failed" } }, { analyzeWebsite: analyze });
		// An automatic retry finds the case retried by hand meanwhile (queued): that retry runs it instead.
		await website(9n, "queued");
		await runWebsiteVisit({ payload: { submissionId: "9", trigger: "automatic" } }, { analyzeWebsite: analyze });
		expect((await SubmissionsEntity.get(9n))?.status).toBe("queued");
	});

	test("an automatic retry that found no browser goes on as that retry once one is free; one retried by hand meanwhile is left to that retry", async () => {
		const visited: bigint[] = [];
		const analyze = async ({ submissionId }: { submissionId: bigint }) => { visited.push(submissionId); };
		for (const [id, by] of [[11n, "automatic"], [12n, "manual"]] as const) {
			await website(id, "failed", { autoRetry: { attempts: 1, nextAttemptAt: new Date().toISOString(), reason: "unreachable" } });
			await claimRetry({ id, status: "failed" }, by, { to: "queued" });
			await runWebsiteVisit({ payload: { submissionId: id.toString(), trigger: "automatic" } }, { analyzeWebsite: analyze });
		}
		expect(visited).toEqual([11n]);
		// The deferred retry claimed nothing again.
		expect((await SubmissionRetriesEntity.listForSubmission(11n)).map((retry) => retry.trigger)).toEqual(["automatic"]);
	});

	test("a malformed job fails loudly instead of visiting anything", async () => {
		await expect(runWebsiteVisit({ payload: { trigger: "initial" } })).rejects.toThrow("names no case");
		await expect(runWebsiteVisit({ payload: { submissionId: "1", trigger: "later" } })).rejects.toThrow("unknown trigger");
	});

	test("the job's signal reaches the analysis", async () => {
		await website(1n, "queued");
		const controller = new AbortController();
		const signals: Array<AbortSignal | undefined> = [];
		await runWebsiteVisit({ payload: { submissionId: "1", trigger: "initial" } }, { signal: controller.signal, analyzeWebsite: async (_options, dependencies) => { signals.push(dependencies.signal); } });
		expect(signals).toEqual([controller.signal]);
	});
});

test("fair keys: the reporter's address, else the kind of source", () => {
	expect(fairKeyOf({ reporterIp: "5.189.203.86", source: "https://x/" })).toBe("ip:5.189.203.86");
	expect(fairKeyOf({ source: "kit-sibling:1:2" })).toBe("source:kit-sibling");
	expect(fairKeyOf({ source: null })).toBe("source:unknown");
});
