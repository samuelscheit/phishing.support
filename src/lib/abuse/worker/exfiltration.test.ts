import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { SubmissionsEntity } from "../../db/entities";
import { getDb } from "../../db";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { reportConfirmedWebsitePhishing } from "../submission_reports";
import { ExfiltrationProbeExhaustedError, runExfiltrationProbe } from "../../exfiltration/probe";
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
			exfiltrationProbe: async () => ({ requests: 5, backends: 2, egress: "phishing" as const }),
		});
		expect(await worker.processOne(false, { jobTypes: ["probe_exfiltration"] })).toBeTrue();
		expect((await SubmissionsEntity.get(submissionId))?.data).toMatchObject({ website: { backendProbe: { status: "completed", backendCount: 2 } } });
		expect((await getDb()).select().from(abuseJobs).where(eq(abuseJobs.id, job.id)).get()?.status).toBe("completed");
	});

	test("an exhausted route set fails the job at once, with no retry and no further Skyvern tasks", async () => {
		const submissionId = 403n;
		const { report, job } = await probeContext(submissionId);
		let attempts = 0;
		const worker = new AbuseWorker({
			owner: "probe-exhausted",
			adapter,
			exfiltrationProbe: async () => {
				attempts++;
				throw new ExfiltrationProbeExhaustedError([{ egress: "phishing", reason: "blocked" }]);
			},
		});
		expect(await worker.processOne(false, { jobTypes: ["probe_exfiltration"] })).toBeTrue();
		expect(attempts).toBe(1);
		const stored = (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.id, job.id)).get();
		expect(stored).toMatchObject({ status: "failed", retryCount: 0 });
		expect(stored?.lastError).toContain("exhausted every route");
		expect((await AbuseRepository.getReport(report.reportId))?.status).toBe("accepted");
		expect((await SubmissionsEntity.get(submissionId))?.data).toMatchObject({ website: { backendProbe: { status: "failed" } } });
	});

	test("a retryable probe failure leaves the submission queued, not failed", async () => {
		const submissionId = 405n;
		await probeContext(submissionId);
		const worker = new AbuseWorker({
			owner: "probe-queued",
			adapter,
			exfiltrationProbe: async () => { throw new Error("Expected 101 status code"); },
		});
		await worker.processOne(false, { jobTypes: ["probe_exfiltration"] });
		expect((await SubmissionsEntity.get(submissionId))?.data).toMatchObject({ website: { backendProbe: { status: "queued" } } });
	});

	test("a browser-service failure before any route verdict is retried, not treated as exhausted", async () => {
		const submissionId = 404n;
		const { job } = await probeContext(submissionId);
		const worker = new AbuseWorker({
			owner: "probe-infra",
			adapter,
			exfiltrationProbe: async () => { throw new Error("Expected 101 status code"); },
		});
		expect(await worker.processOne(false, { jobTypes: ["probe_exfiltration"] })).toBeTrue();
		const stored = (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.id, job.id)).get();
		expect(stored).toMatchObject({ status: "queued", retryCount: 1 });
	});

	test("site verdicts on every route from a real Skyvern run end the job after one walk, with no whole-job retry", async () => {
		const submissionId = 404n;
		const { report, job } = await probeContext(submissionId);
		const runsByEgress: string[] = [];
		// Upstream planning-limit and anti-bot wording, which the previous classifier sent to infrastructure retry.
		const siteVerdicts: Record<string, { status: string; failure_reason: string }> = {
			phishing: { status: "failed", failure_reason: "Max steps exceeded" },
			reporting: { status: "failed", failure_reason: "Cloudflare challenge did not clear" },
			residential: { status: "failed", failure_reason: "Could not verify you are human" },
		};
		const siteVerdict = (egress: string) => siteVerdicts[egress]!;
		const fakeAdapter = {
			createTask: async (_payload: unknown, options?: { browserAddress: string }) => {
				const egress = options?.browserAddress.replace("ws://relay/", "") ?? "unknown";
				runsByEgress.push(egress);
				return { runId: `run-${egress}`, response: {} };
			},
			getRun: async (runId: string) => siteVerdict(runId.replace("run-", "")),
			cancelRun: async () => undefined,
		};
		const worker = new AbuseWorker({
			owner: "probe-real-verdicts",
			adapter: fakeAdapter as never,
			exfiltrationProbe: (input, adapter, signal) => runExfiltrationProbe(input, adapter, signal, {
				createCanaries: () => ({ marker: "psprobe_0123456789abcdef", email: "probe.0123456789abcdef@probe-canary.invalid", password: "A9!psprobe_0123456789abcdef!qZ", phone: "+15550100123", cardNumber: "4242424242424242", oneTimeCode: "123456" }),
				acquireBinding: async (egress) => ({ sessionId: `browser-session_${egress}`, browserAddress: `ws://relay/${egress}`, release: async () => undefined, cancel: async () => undefined }),
				connectBrowser: async () => ({ disconnect: () => undefined } as never),
				createRecorder: () => ({ start: async () => undefined, stop: async () => [] }),
				heartbeat: async () => undefined,
				sleep: async () => undefined,
			}),
		});
		expect(await worker.processOne(false, { jobTypes: ["probe_exfiltration"] })).toBeTrue();
		// Each route is tried exactly once, in the shared Tor → server IP → residential order.
		expect(runsByEgress).toEqual(["phishing", "reporting", "residential"]);
		expect((await getDb()).select().from(abuseJobs).where(eq(abuseJobs.id, job.id)).get())
			.toMatchObject({ status: "failed", retryCount: 0 });
		expect((await AbuseRepository.getReport(report.reportId))?.status).toBe("accepted");
		expect((await SubmissionsEntity.get(submissionId))?.data).toMatchObject({ website: { backendProbe: { status: "failed" } } });
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
