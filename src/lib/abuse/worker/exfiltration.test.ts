import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { SubmissionsEntity } from "../../db/entities";
import { getDb } from "../../db";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { reportConfirmedWebsitePhishing } from "../submission_reports";
import { abuseJobs } from "../schema";
import { AbuseRepository } from "../repository";
import { AbuseWorker } from "../worker";

useTemporaryDatabase();

async function probeContext(id: bigint) {
	await SubmissionsEntity.create({
		id,
		kind: "website",
		data: { kind: "website", website: { url: "https://phish.example.com/" } },
		dedupeKey: `exfil-worker:${id.toString()}`,
	});
	const report = await reportConfirmedWebsitePhishing({
		submissionId: id,
		urls: ["https://phish.example.com/"],
		analysisText: "The page collects account credentials.",
		phishingBasis: "credential_theft",
		reporter: {},
	});
	const job = (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.jobType, "probe_exfiltration")).get()!;
	return { report, job };
}

const adapter = {} as never;

describe("exfiltration probe worker lifecycle", () => {
	test("moves durable probe state from queued through completed", async () => {
		const submissionId = 401n;
		const { job } = await probeContext(submissionId);
		expect((await SubmissionsEntity.get(submissionId))?.data).toMatchObject({ website: { backendProbe: { status: "queued" } } });
		const worker = new AbuseWorker({
			owner: "probe-success",
			adapter,
			exfiltrationProbe: async () => ({ requests: 5, backends: 2 }),
		});
		expect(await worker.processOne(false, { jobTypes: ["probe_exfiltration"] })).toBeTrue();
		expect((await SubmissionsEntity.get(submissionId))?.data).toMatchObject({ website: { backendProbe: { status: "completed", backendCount: 2 } } });
		expect((await getDb()).select().from(abuseJobs).where(eq(abuseJobs.id, job.id)).get()?.status).toBe("completed");
	});

	test("retry exhaustion fails only the supplementary probe, never the phishing report", async () => {
		const submissionId = 402n;
		const { report, job } = await probeContext(submissionId);
		(await getDb()).update(abuseJobs).set({ retryCount: 8 }).where(eq(abuseJobs.id, job.id)).run();
		const worker = new AbuseWorker({
			owner: "probe-failure",
			adapter,
			exfiltrationProbe: async () => { throw new Error("browser unavailable"); },
		});
		expect(await worker.processOne(false, { jobTypes: ["probe_exfiltration"] })).toBeTrue();
		expect((await getDb()).select().from(abuseJobs).where(eq(abuseJobs.id, job.id)).get()).toMatchObject({ status: "failed", lastError: "browser unavailable" });
		expect((await AbuseRepository.getReport(report.reportId))?.status).toBe("accepted");
		expect((await SubmissionsEntity.get(submissionId))?.data).toMatchObject({ website: { backendProbe: { status: "failed", lastError: "browser unavailable" } } });
	});
});
