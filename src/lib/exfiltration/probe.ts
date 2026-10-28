import type { Browser } from "rebrowser-puppeteer-core";

import { AbuseRepository } from "../abuse/repository";
import type { AbuseSkyvernAdapter } from "../abuse/skyvern/adapter";
import { statusOf } from "../abuse/skyvern/contracts";
import {
	acquireFabricSkyvernTaskBinding,
	connectFabricPuppeteerClient,
	heartbeatFabricBrowserSession,
	type FabricSkyvernTaskBinding,
} from "../browser/fabric";
import type { ReporterMetadata } from "../request_metadata";
import { stableJson } from "../abuse/security";
import { discoverExfiltrationBackends } from "./analysis";
import { createExfiltrationCanaries } from "./canaries";
import { enrichBackendIdentity } from "./identity";
import { ExfiltrationNetworkRecorder } from "./recorder";
import { reportExfiltrationBackend } from "./reporting";
import { buildExfiltrationProbeTask } from "./task";
import type { CapturedNetworkRequest, ExfiltrationBackend, ExfiltrationCanaries } from "./types";

const TERMINAL = new Set(["completed", "failed", "terminated", "timed_out", "canceled"]);
const POLL_MS = 2_000;

export type ExfiltrationProbeInput = {
	reportId: bigint;
	submissionId: bigint;
	pageUrl: string;
	reporter: ReporterMetadata;
};

type Recorder = { start(browser: Browser): Promise<void>; stop(): Promise<CapturedNetworkRequest[]> };

export type ExfiltrationProbeDependencies = {
	createCanaries(): ExfiltrationCanaries;
	acquireBinding(): Promise<FabricSkyvernTaskBinding>;
	connectBrowser(address: string): Promise<Browser>;
	createRecorder(): Recorder;
	enrich(backend: ExfiltrationBackend, signal?: AbortSignal): Promise<ExfiltrationBackend>;
	report(params: ExfiltrationProbeInput & { backend: ExfiltrationBackend; observedAt: Date; sourceReportId: bigint }): Promise<unknown>;
	saveCapture(reportId: bigint, capture: Buffer, metadata: Record<string, unknown>): Promise<unknown>;
	heartbeat(sessionId: string): Promise<void>;
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

function defaultDependencies(): ExfiltrationProbeDependencies {
	return {
		createCanaries: createExfiltrationCanaries,
		acquireBinding: () => acquireFabricSkyvernTaskBinding(
			{ operation: "exfiltration-probe" },
			{ egress: "phishing", maxExternalConnections: 2 },
		),
		connectBrowser: connectFabricPuppeteerClient,
		createRecorder: () => new ExfiltrationNetworkRecorder(),
		enrich: (backend, signal) => enrichBackendIdentity(backend, globalThis.fetch, signal),
		report: ({ reportId: _reportId, sourceReportId, ...params }) => reportExfiltrationBackend({ ...params, sourceReportId }),
		saveCapture: (reportId, capture, metadata) => AbuseRepository.saveArtifact({
			reportId,
			name: "exfiltration-network-capture.json",
			kind: "exfiltration_network_capture",
			mimeType: "application/json",
			buffer: capture,
			metadata,
		}),
		heartbeat: heartbeatFabricBrowserSession,
		sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
			let abort: (() => void) | undefined;
			const timer = setTimeout(() => {
				if (abort) signal?.removeEventListener("abort", abort);
				resolve();
			}, ms);
			if (!signal) return;
			abort = () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error("Probe canceled.")); };
			signal.addEventListener("abort", abort, { once: true });
		}),
	};
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error("Exfiltration probe canceled.");
}

export async function runExfiltrationProbe(
	input: ExfiltrationProbeInput,
	adapter: Pick<AbuseSkyvernAdapter, "createTask" | "getRun" | "cancelRun">,
	signal?: AbortSignal,
	dependencies: Partial<ExfiltrationProbeDependencies> = {},
): Promise<{ requests: number; backends: number }> {
	const deps = { ...defaultDependencies(), ...dependencies };
	const canaries = deps.createCanaries();
	const observedAt = new Date();
	const binding = await deps.acquireBinding();
	let browser: Browser | undefined;
	let recorder: Recorder | undefined;
	let runId: string | undefined;
	let succeeded = false;
	const heartbeat = setInterval(() => { void deps.heartbeat(binding.sessionId).catch(() => undefined); }, 10_000);
	heartbeat.unref?.();
	try {
		throwIfAborted(signal);
		browser = await deps.connectBrowser(binding.browserAddress);
		recorder = deps.createRecorder();
		await recorder.start(browser);
		throwIfAborted(signal);
		const created = await adapter.createTask(buildExfiltrationProbeTask(input.pageUrl, canaries), { browserAddress: binding.browserAddress });
		runId = created.runId;

		while (true) {
			throwIfAborted(signal);
			const run = await adapter.getRun(runId);
			const status = statusOf(run);
			if (status && TERMINAL.has(status)) {
				if (status !== "completed") throw new Error(`Skyvern exfiltration probe ended in ${status}.`);
				break;
			}
			await deps.sleep(POLL_MS, signal);
		}
		// Let beacon and WebSocket frames queued by the final click reach CDP.
		await deps.sleep(500, signal);
		const requests = await recorder.stop();
		recorder = undefined;
		const discoveries = discoverExfiltrationBackends({ requests, canaries, pageUrl: input.pageUrl });
		const enriched: ExfiltrationBackend[] = [];
		for (const backend of discoveries) {
			try {
				enriched.push(await deps.enrich(backend, signal));
			} catch {
				enriched.push(backend);
			}
		}
		const capture = Buffer.from(stableJson({
			version: 1,
			observedAt: observedAt.toISOString(),
			pageUrl: input.pageUrl,
			canaries,
			requests,
			backends: enriched,
		}), "utf8");
		await deps.saveCapture(input.reportId, capture, { pageUrl: input.pageUrl, requestCount: requests.length, backendCount: enriched.length });
		for (const backend of enriched) {
			await deps.report({ ...input, sourceReportId: input.reportId, backend, observedAt });
		}
		succeeded = true;
		return { requests: requests.length, backends: enriched.length };
	} finally {
		clearInterval(heartbeat);
		if (recorder) await recorder.stop().catch(() => undefined);
		if (browser) await Promise.resolve(browser.disconnect()).catch(() => undefined);
		if (succeeded) await binding.release().catch(() => undefined);
		else {
			if (runId) await adapter.cancelRun(runId).catch(() => undefined);
			await binding.cancel().catch(() => undefined);
		}
	}
}
