import { AbuseRepository } from "../repository";
import { resolveAbuseTarget } from "../resolver";
import { acquireFabricCdpSession, cancelFabricBrowserSession } from "../../browser/fabric";
import { browserTaskModel, type ChatModel } from "../../browser/task/agent";
import type { FabricCdpSessionAcquirer } from "../../browser/task/fabric";
import { fabricBrowserSessionIdFromProviderPayload } from "../../browser/fabric_session";
import type { AbuseJob } from "../schema";
import { ensureRelayRefusalResends } from "./email";
import { ensureCorrespondencePolls } from "./correspondence";
import { ensureReceiptLookups } from "./receipt";
import { ensureOriginHostDisclosureJobs } from "../origin/disclosure";
import { boundedErrorText } from "../../util/error_text";
import { randomOwner, type WorkerServices } from "./shared";
import type { JobClaimFilter } from "../persistence/jobs";
import { releaseAfterFailedInvestigation, runReportInvestigation } from "../../investigation/run";
import { startSamplePurgeSchedule } from "../../exfiltration/downloads/sample_purge_job";
import { enqueueRulesSweep } from "../../campaign/sweep";
import { ensureLivenessChecks } from "../../liveness/schedule";
import { sleep } from "../../util/sleep";
import { isExternalJob, JOB_HANDLERS, JOB_LANES, JOB_POLICY, jobTimeoutMs, laneFilter, type JobLane } from "./jobs";
import { MAX_RETRIES, retryDelayMs } from "./retry";

const DEFAULT_LEASE_MS = 90_000;
const DEFAULT_POLL_MS = 1_500;
const DEFAULT_CONTROL_CONCURRENCY = 2;
const DEFAULT_EXTERNAL_CONCURRENCY = 2;
const MAX_LANE_CONCURRENCY = 16;
const DEFAULT_CONTROL_JOB_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_EXTERNAL_JOB_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_SWEEP_JOB_TIMEOUT_MS = 20 * 60_000;
const LIVENESS_JOB_TIMEOUT_MS = 5 * 60_000;
const MAX_JOB_TIMEOUT_MS = 60 * 60_000;

class JobExecutionTimeoutError extends Error {
	readonly code = "ABUSE_JOB_TIMEOUT";

	constructor(readonly job: AbuseJob, readonly timeoutMs: number) {
		super(`Abuse job ${job.id.toString()} (${job.jobType}) exceeded its ${timeoutMs} ms execution deadline.`);
		this.name = "JobExecutionTimeoutError";
	}
}

/**
 * An error whose own type states that repeating the work cannot change the
 * outcome. Only typed verdicts set `retryable: false`; a message match never
 * makes a failure terminal.
 */
function isNonRetryableError(error: unknown): boolean {
	return (error as { retryable?: unknown } | null)?.retryable === false;
}

class WorkerStoppingError extends Error {
	constructor() {
		super("Abuse worker is stopping.");
		this.name = "WorkerStoppingError";
	}
}

function boundedConcurrency(value: number, fallback: number): number {
	return Math.min(MAX_LANE_CONCURRENCY, Math.max(1, Number.isSafeInteger(value) ? value : fallback));
}

function boundedTimeout(value: number, fallback: number): number {
	return Math.min(MAX_JOB_TIMEOUT_MS, Math.max(1_000, Number.isFinite(value) ? value : fallback));
}

export type AbuseWorkerOptions = {
	owner?: string;
	leaseMs?: number;
	pollMs?: number;
	/** Number of resolver/reconciliation jobs that may run at once. */
	controlConcurrency?: number;
	/** Number of provider/browser jobs that may run at once. */
	externalConcurrency?: number;
	/** Override the control-lane execution deadline (primarily for tests). */
	controlJobTimeoutMs?: number;
	/** Override the provider-lane execution deadline (primarily for tests). */
	externalJobTimeoutMs?: number;
	/** Override the origin-sweep execution deadline (primarily for tests). */
	sweepJobTimeoutMs?: number;
	/** Deterministic test hook; production always dispatches through the provider registry. */
	processJob?: (job: AbuseJob, signal?: AbortSignal) => Promise<void>;
	/** Test hook: the model that drives browser tasks (production uses the app's OpenAI model). */
	browserTaskModel?: () => ChatModel;
	/** Test hook: the browser a browser task runs on (production leases a Fabric browser). */
	acquireBrowserSession?: FabricCdpSessionAcquirer;
	/** Test hook; production uses the resolver implementation above. */
	resolveTarget?: typeof resolveAbuseTarget;
	/** Deterministic test hook for the pre-report evidence investigation. */
	investigateReport?: typeof runReportInvestigation;
};

/**
 * Owns worker lifecycle, leases, retries, and job routing. Individual job
 * handlers live beside the provider or transport concern they operate on.
 */
export class AbuseWorker {
	private readonly owner: string;
	private readonly leaseMs: number;
	private readonly pollMs: number;
	private readonly controlConcurrency: number;
	private readonly externalConcurrency: number;
	private readonly controlJobTimeoutMs: number;
	private readonly externalJobTimeoutMs: number;
	private readonly sweepJobTimeoutMs: number;
	private readonly resolveTarget: typeof resolveAbuseTarget;
	private readonly services: WorkerServices;
	private stopped = true;
	private loopPromises: Promise<void>[] = [];
	private stopSamplePurge: (() => void) | undefined;
	private readonly activeControllers = new Set<AbortController>();
	private readonly processJobOverride: AbuseWorkerOptions["processJob"];
	private readonly investigateReport: typeof runReportInvestigation;

	constructor(options: AbuseWorkerOptions = {}) {
		this.owner = options.owner ?? randomOwner();
		this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
		this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
		this.controlConcurrency = boundedConcurrency(options.controlConcurrency ?? DEFAULT_CONTROL_CONCURRENCY, DEFAULT_CONTROL_CONCURRENCY);
		this.externalConcurrency = boundedConcurrency(options.externalConcurrency ?? DEFAULT_EXTERNAL_CONCURRENCY, DEFAULT_EXTERNAL_CONCURRENCY);
		this.controlJobTimeoutMs = boundedTimeout(options.controlJobTimeoutMs ?? DEFAULT_CONTROL_JOB_TIMEOUT_MS, DEFAULT_CONTROL_JOB_TIMEOUT_MS);
		this.externalJobTimeoutMs = boundedTimeout(options.externalJobTimeoutMs ?? DEFAULT_EXTERNAL_JOB_TIMEOUT_MS, DEFAULT_EXTERNAL_JOB_TIMEOUT_MS);
		this.sweepJobTimeoutMs = boundedTimeout(options.sweepJobTimeoutMs ?? DEFAULT_SWEEP_JOB_TIMEOUT_MS, DEFAULT_SWEEP_JOB_TIMEOUT_MS);
		this.processJobOverride = options.processJob;
		this.resolveTarget = options.resolveTarget ?? resolveAbuseTarget;
		this.investigateReport = options.investigateReport ?? runReportInvestigation;
		this.services = {
			owner: this.owner,
			// Resolved per task, so routes that never use a portal never need a model.
			browserTaskModel: options.browserTaskModel ?? (() => browserTaskModel()),
			acquireBrowserSession: options.acquireBrowserSession ?? ((metadata, sessionOptions) => acquireFabricCdpSession(metadata, sessionOptions)),
			markUnknownExternal: (params) => this.markUnknownExternal(params),
		};
	}

	private async markUnknownExternal(params: { routeId: bigint; runId?: bigint; error: string; reason: string }): Promise<void> {
		await AbuseRepository.markUnknownExternalState(params);
		if (params.runId !== undefined) {
			const run = await AbuseRepository.getProviderRun(params.runId);
			const sessionId = fabricBrowserSessionIdFromProviderPayload(run?.providerPayload);
			if (sessionId) await cancelFabricBrowserSession(sessionId).catch(() => undefined);
		}
	}

	async start(): Promise<void> {
		if (!this.stopped) return;
		this.stopped = false;
		await AbuseRepository.recoverStaleJobs();
		await ensureCorrespondencePolls();
		await ensureReceiptLookups();
		await ensureOriginHostDisclosureJobs();
		await ensureLivenessChecks();
		await ensureRelayRefusalResends();
		// Every confirmed site is linked again once whenever the campaign rules change.
		await enqueueRulesSweep();
		// Provider/browser work gets its own lane. A stuck CAPTCHA or browser can
		// therefore never consume the capacity reserved for resolution,
		// reconciliation, and inbound correspondence jobs.
		const slots: Record<JobLane, number> = { control: this.controlConcurrency, external: this.externalConcurrency, sweep: 1, link: 1, discovery: 1, liveness: 1 };
		this.loopPromises = JOB_LANES.flatMap((lane) => Array.from({ length: slots[lane] }, () => this.runLoop(laneFilter(lane))));
		this.stopSamplePurge = startSamplePurgeSchedule();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.stopSamplePurge?.();
		this.stopSamplePurge = undefined;
		for (const controller of this.activeControllers) controller.abort(new WorkerStoppingError());
		await Promise.all(this.loopPromises);
		this.loopPromises = [];
	}

	private async runLoop(filter: JobClaimFilter): Promise<void> {
		while (!this.stopped) {
			try {
				const processed = await this.processOne(filter);
				if (!processed) await sleep(this.pollMs);
			} catch (error) {
				console.error("Abuse worker loop error:", error);
				await sleep(this.pollMs);
			}
		}
	}

	async processOne(filter?: JobClaimFilter): Promise<boolean> {
		const job = await AbuseRepository.claimNextJob(this.owner, this.leaseMs, filter);
		if (!job) return false;
		const controller = new AbortController();
		this.activeControllers.add(controller);
		const heartbeat = setInterval(() => {
			void AbuseRepository.renewJobLease(job.id, this.owner, this.leaseMs).catch((error) => {
				console.error(`Failed to renew abuse job ${job.id.toString()} lease:`, error);
			});
		}, Math.max(1_000, Math.floor(this.leaseMs / 3)));
		try {
			await this.runJobWithDeadline(job, controller, jobTimeoutMs(job.jobType, { control: this.controlJobTimeoutMs, external: this.externalJobTimeoutMs, sweep: this.sweepJobTimeoutMs, liveness: LIVENESS_JOB_TIMEOUT_MS }));
			await AbuseRepository.completeJob(job.id, this.owner);
		} catch (error) {
			await this.settleFailedJob(job, error);
		} finally {
			clearInterval(heartbeat);
			this.activeControllers.delete(controller);
		}
		return true;
	}

	/** A job's error decides its fate: fenced or left for recovery when interrupted, else failed for good or queued again. */
	private async settleFailedJob(job: AbuseJob, error: unknown): Promise<void> {
		if (error instanceof WorkerStoppingError) return this.handleInterruptedJob(job, error.message, "worker_stopping");
		if (error instanceof JobExecutionTimeoutError) return this.handleInterruptedJob(job, error.message, "job_execution_timeout", true);
		const message = boundedErrorText(error);
		if (job.unknownExternalState || (error as { unknownExternalState?: unknown })?.unknownExternalState === true) {
			await AbuseRepository.markJobUnknownExternalState({ jobId: job.id, owner: this.owner, error: message });
		} else if (isNonRetryableError(error) || job.retryCount >= MAX_RETRIES) {
			// A typed verdict that repeating the same work cannot change fails now rather than spending the remaining retries.
			await this.failRetryExhaustedJob(job, message);
		} else {
			await AbuseRepository.retryJob({ jobId: job.id, owner: this.owner, error: message, afterMs: retryDelayMs(error, job.retryCount) });
		}
	}

	/**
	 * Enforce a deadline independently of provider SDK cancellation support.
	 * The signal is propagated to code-owned adapters, while the detached
	 * promise is observed so a late rejection cannot become an unhandled
	 * process-level rejection. A timed-out operation is fenced below according
	 * to its durable external-boundary state.
	 */
	private async runJobWithDeadline(job: AbuseJob, controller: AbortController, timeoutMs: number): Promise<void> {
		const operation = this.processJobOverride
			? this.processJobOverride(job, controller.signal)
			: this.processJob(job, controller.signal);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let removeAbortListener: (() => void) | undefined;
		const interruption = new Promise<never>((_, reject) => {
			const onAbort = () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new WorkerStoppingError());
			removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
			controller.signal.addEventListener("abort", onAbort, { once: true });
		});
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				const timeout = new JobExecutionTimeoutError(job, timeoutMs);
				controller.abort(timeout);
				reject(timeout);
			}, timeoutMs);
		});
		operation.catch(() => undefined);
		try {
			await Promise.race([operation, interruption, deadline]);
		} finally {
			if (timer) clearTimeout(timer);
			removeAbortListener?.();
		}
	}

	private async handleInterruptedJob(
		job: AbuseJob,
		message: string,
		reason: "job_execution_timeout" | "worker_stopping",
		retryUnfenced = false,
	): Promise<void> {
		const route = job.routeId ? await AbuseRepository.getRoute(job.routeId) : undefined;
		const run = job.runId
			? await AbuseRepository.getProviderRun(job.runId)
			: route
				? await AbuseRepository.getLatestActiveProviderRunForRoute(route.id)
				: undefined;
		// Once a route-owned run exists, a non-cooperative provider promise could
		// still reach its boundary after this worker returns—even when the run is
		// currently in its preflight phase. Fence every such run. Only jobs that
		// have not created a run at all can be retried automatically after a
		// timeout.
		const shouldFence = Boolean(
			route && run
			&& isExternalJob(job)
			&& (reason === "job_execution_timeout" || run.executionStatus !== "starting")
		);
		if (shouldFence && route) {
			await this.markUnknownExternal({
				routeId: route.id,
				runId: run?.id,
				error: `${message} The external operation was fenced; reconciliation is required before any retry.`,
				reason,
			});
			await AbuseRepository.markJobUnknownExternalState({
				jobId: job.id,
				owner: this.owner,
				error: `${message} The external operation was fenced; reconciliation is required before any retry.`,
			});
			return;
		}
		// A timeout before a durable provider boundary is a normal retryable
		// failure. During an intentional process shutdown leave the lease for
		// startup recovery instead; a second worker must not overlap a detached
		// local operation while the old process is still draining.
		if (!retryUnfenced) return;
		if (job.retryCount >= MAX_RETRIES) {
			await this.failRetryExhaustedJob(job, message);
		} else {
			await AbuseRepository.retryJob({ jobId: job.id, owner: this.owner, error: message, afterMs: retryDelayMs(undefined, job.retryCount) });
		}
	}

	private async failRetryExhaustedJob(job: AbuseJob, error: string): Promise<void> {
		if (JOB_POLICY[job.jobType].supplementary) {
			// Evidence gathering, infrastructure, campaigns, kit discovery and site checks are supplementary:
			// their failure must not turn a successfully submitted phishing report into a reporting failure.
			await AbuseRepository.failJob({ jobId: job.id, owner: this.owner, error });
			// A confirmed site is reported without the evidence its investigation failed to gather.
			if (job.jobType === "investigate_report" && job.reportId) {
				const report = await AbuseRepository.getReport(job.reportId);
				await releaseAfterFailedInvestigation(job.reportId, report?.submissionId ?? undefined, error);
			}
			return;
		}
		if (job.jobType === "submit_provider" && await AbuseRepository.failProviderSubmissionPreflight({
			jobId: job.id,
			owner: this.owner,
			error,
		})) return;
		await AbuseRepository.failJob({ jobId: job.id, owner: this.owner, error });
		if (job.routeId) {
			const route = await AbuseRepository.getRoute(job.routeId);
			if (route) {
				await AbuseRepository.transitionRouteStatus({
					routeId: route.id,
					from: ["resolving", "verified", "queued", "running", "awaiting_provider_reply", "escalating_to_portal", "delivery_failed"],
					to: "failed",
					data: { reason: "retry_exhausted", error },
				});
			}
			return;
		}
		if (job.reportId) {
			await AbuseRepository.transitionReportStatus({
				reportId: job.reportId,
				from: ["accepted", "resolving", "verifying", "queued", "running", "waiting_provider"],
				to: "failed",
				data: { reason: "retry_exhausted", error },
			});
		}
	}

	private async processJob(job: AbuseJob, signal?: AbortSignal): Promise<void> {
		await JOB_HANDLERS[job.jobType](job, {
			...(signal ? { signal } : {}),
			services: this.servicesFor(signal),
			resolveTarget: this.resolveTarget,
			investigateReport: this.investigateReport,
		});
	}

	private servicesFor(signal?: AbortSignal): WorkerServices {
		return {
			...this.services,
			...(signal ? { signal } : {}),
		};
	}
}

let singletonWorker: AbuseWorker | undefined;

export async function startAbuseWorker(): Promise<AbuseWorker> {
	singletonWorker ??= new AbuseWorker();
	await singletonWorker.start();
	return singletonWorker;
}

export async function stopAbuseWorker(): Promise<void> {
	await singletonWorker?.stop();
	singletonWorker = undefined;
}
