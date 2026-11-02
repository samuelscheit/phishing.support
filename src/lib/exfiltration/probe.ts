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
import type { FabricEgress } from "../browser/fabric";
import type { ReporterMetadata } from "../request_metadata";
import { stableJson } from "../abuse/security";
import { discoverExfiltrationBackends } from "./analysis";
import { createExfiltrationCanaries } from "./canaries";
import { enrichBackendIdentity } from "./identity";
import { ExfiltrationNetworkRecorder } from "./recorder";
import { reportExfiltrationBackend } from "./reporting";
import { PROBE_EGRESS_ORDER, routeVerdictForFailedRun, runProbeRoutes } from "./routes";
import { buildExfiltrationProbeTask, INVESTIGATION_BUDGET_MS } from "./task";
import { collectDownloads, type CollectedDownload } from "./downloads/collect";
import { downloadPipelineConfigFromEnvironment, investigateCollectedDownload } from "./downloads/pipeline";
import type { CapturedNetworkRequest, ExfiltrationBackend, ExfiltrationCanaries } from "./types";
import { WebsiteUnreachableError } from "../website_archive";
import { errorText } from "../error_text";
import { redactExternalError } from "../abuse/skyvern/adapter";

const TERMINAL = new Set(["completed", "failed", "terminated", "timed_out", "canceled"]);
const POLL_MS = 2_000;

export type ExfiltrationProbeInput = {
	reportId: bigint;
	submissionId: bigint;
	pageUrl: string;
	/** The classification that enqueued the probe; it decides whether a download may ever be uploaded. */
	phishingBasis: "credential_theft" | "payment_fraud" | "malware_delivery";
	reporter: ReporterMetadata;
};

type Recorder = { start(browser: Browser): Promise<void>; stop(): Promise<CapturedNetworkRequest[]> };

/**
 * Every route was tried and each one reached a terminal verdict. Retrying the
 * same URL from the same egress set cannot change that, so the job must not
 * run another eight Skyvern tasks.
 */
export class ExfiltrationProbeExhaustedError extends Error {
	readonly retryable = false;

	constructor(readonly failures: ReadonlyArray<{ egress: FabricEgress; reason: string }>) {
		super(`Exfiltration probe exhausted every route: ${failures.map((failure) => `${failure.egress} (${failure.reason})`).join("; ")}`);
		this.name = "ExfiltrationProbeExhaustedError";
	}
}

/**
 * The investigation budget ran out before any route captured the page. The
 * budget is a deliberate stop, so this is terminal: a retry would spend the
 * same budget again on the same site.
 */
export class ExfiltrationProbeBudgetError extends Error {
	readonly retryable = false;

	constructor(readonly budgetMs: number) {
		super(`Exfiltration investigation budget of ${budgetMs} ms elapsed before any route completed.`);
		this.name = "ExfiltrationProbeBudgetError";
	}
}

export type ExfiltrationProbeDependencies = {
	createCanaries(): ExfiltrationCanaries;
	acquireBinding(egress: FabricEgress): Promise<FabricSkyvernTaskBinding>;
	connectBrowser(address: string): Promise<Browser>;
	createRecorder(): Recorder;
	enrich(backend: ExfiltrationBackend, signal?: AbortSignal): Promise<ExfiltrationBackend>;
	report(params: ExfiltrationProbeInput & { backend: ExfiltrationBackend; observedAt: Date; sourceReportId: bigint }): Promise<unknown>;
	saveCapture(reportId: bigint, capture: Buffer, metadata: Record<string, unknown>): Promise<unknown>;
	heartbeat(sessionId: string): Promise<void>;
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
	/** Wall-clock budget for every route together; defaults to the approved eight minutes. */
	investigationBudgetMs: number;
	/** Fetch and hash one collected download, then keep it. Failures here never fail the probe. */
	investigateDownload(file: CollectedDownload, phishingBasis: ExfiltrationProbeInput["phishingBasis"]): Promise<unknown>;
};

function defaultDependencies(): ExfiltrationProbeDependencies {
	return {
		createCanaries: createExfiltrationCanaries,
		acquireBinding: (egress) => acquireFabricSkyvernTaskBinding(
			{ operation: "exfiltration-probe" },
			{ egress, maxExternalConnections: 2 },
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
		investigationBudgetMs: INVESTIGATION_BUDGET_MS,
		investigateDownload: (file, phishingBasis) => investigateCollectedDownload(file, downloadPipelineConfigFromEnvironment(), { phishingBasis }),
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

/** One Fabric binding, one Skyvern run, and one recorder per route. */
async function attemptRoute(
	egress: FabricEgress,
	input: ExfiltrationProbeInput,
	canaries: ExfiltrationCanaries,
	adapter: Pick<AbuseSkyvernAdapter, "createTask" | "getRun" | "cancelRun">,
	deps: ExfiltrationProbeDependencies,
	signal: AbortSignal | undefined,
): Promise<{ egress: FabricEgress; value: { requests: CapturedNetworkRequest[]; downloads: CollectedDownload[]; binding: FabricSkyvernTaskBinding } }> {
	const binding = await deps.acquireBinding(egress);
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

		let completedRun: Record<string, unknown> | undefined;
		while (true) {
			throwIfAborted(signal);
			const run = await adapter.getRun(runId);
			const status = statusOf(run);
			if (status && TERMINAL.has(status)) {
				if (status !== "completed") {
					const failureReason = typeof run.failure_reason === "string" ? run.failure_reason : undefined;
					throw routeVerdictForFailedRun(egress, status, failureReason);
				}
				completedRun = run;
				break;
			}
			await deps.sleep(POLL_MS, signal);
		}
		const downloads = collectDownloads(completedRun?.downloaded_files);
		// Let beacon and WebSocket frames queued by the final click reach CDP.
		await deps.sleep(500, signal);
		const requests = await recorder.stop();
		recorder = undefined;
		succeeded = true;
		return { egress, value: { requests, downloads, binding } };
	} finally {
		clearInterval(heartbeat);
		if (recorder) await recorder.stop().catch(() => undefined);
		if (browser) await Promise.resolve(browser.disconnect()).catch(() => undefined);
		// A failed route's Skyvern task and lease end here. A completed route keeps
		// its lease until the capture is persisted, then releases it in the caller.
		if (!succeeded) {
			if (runId) await adapter.cancelRun(runId).catch(() => undefined);
			await binding.cancel().catch(() => undefined);
		}
	}
}

export async function runExfiltrationProbe(
	input: ExfiltrationProbeInput,
	adapter: Pick<AbuseSkyvernAdapter, "createTask" | "getRun" | "cancelRun">,
	signal?: AbortSignal,
	dependencies: Partial<ExfiltrationProbeDependencies> = {},
): Promise<{ requests: number; backends: number; egress: FabricEgress }> {
	const deps = { ...defaultDependencies(), ...dependencies };
	const canaries = deps.createCanaries();
	const observedAt = new Date();
	// One deadline for the whole investigation, shared by every route. The caller's
	// signal still cancels it, so a worker shutdown and the budget stop the same way.
	const budget = new AbortController();
	const budgetTimer = setTimeout(() => budget.abort(new ExfiltrationProbeBudgetError(deps.investigationBudgetMs)), deps.investigationBudgetMs);
	budgetTimer.unref?.();
	const onCallerAbort = () => budget.abort(signal?.reason);
	signal?.addEventListener("abort", onCallerAbort, { once: true });
	let walked: Awaited<ReturnType<typeof runProbeRoutes<{ requests: CapturedNetworkRequest[]; downloads: CollectedDownload[]; binding: FabricSkyvernTaskBinding }>>>;
	try {
		walked = await runProbeRoutes({
			budget: budget.signal,
			attempt: (egress) => attemptRoute(egress, input, canaries, adapter, deps, budget.signal),
		});
	} catch (error) {
		// A route interrupted by the budget surfaces as the budget's own error, which is
		// terminal. Any other failure keeps its own type and retry behaviour.
		if (budget.signal.aborted && budget.signal.reason instanceof ExfiltrationProbeBudgetError) throw budget.signal.reason;
		throw error;
	} finally {
		clearTimeout(budgetTimer);
		signal?.removeEventListener("abort", onCallerAbort);
	}
	if (walked.outcome === "exhausted") {
		if (walked.reason === "budget") throw new ExfiltrationProbeBudgetError(deps.investigationBudgetMs);
		throw new ExfiltrationProbeExhaustedError(walked.failures.map((failure) => ({ egress: failure.egress, reason: errorText(failure.error) })));
	}
	const { egress, value } = walked;
	// The completed route's lease must end however persistence goes; a stuck lease
	// holds one of the relay's scarce connection slots.
	try {
		const requests = value.requests;
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
			egress,
			canaries,
			requests,
			backends: enriched,
		}), "utf8");
		await deps.saveCapture(input.reportId, capture, { pageUrl: input.pageUrl, egress, requestCount: requests.length, backendCount: enriched.length });
		for (const backend of enriched) {
			await deps.report({ ...input, sourceReportId: input.reportId, backend, observedAt });
		}
		// Downloads come after the capture and reports are durable. A failed download is
		// recorded as skipped; it must never discard the network evidence above.
		for (const file of value.downloads) {
			try {
				await deps.investigateDownload(file, input.phishingBasis);
			} catch (error) {
				console.warn(`Download investigation skipped for ${file.url.origin}: ${redactExternalError(error)}`);
			}
		}
		return { requests: requests.length, backends: enriched.length, egress };
	} finally {
		await value.binding.release().catch(() => undefined);
	}
}
