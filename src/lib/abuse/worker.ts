import { AbuseRepository } from "./repository";
import { resolveAbuseTarget } from "./resolver";
import { AbuseSkyvernAdapter } from "./skyvern";
import { skyvernApiKeySourceIsConfigured } from "./skyvern_config";
import type { AbuseJob, AbuseJobType } from "./schema";
import {
	executeProviderSubmission,
	getPortalProvider,
	getProviderSubmissionProvider,
	listPortalProviders,
} from "./providers";
import { sendEmail } from "./worker/email";
import { classifyReply, monitorProviderReply } from "./worker/mail";
import { runGenericProviderPortal } from "./worker/portal";
import { reconcileGenericSkyvern } from "./worker/reconcile";
import { resolveReport, verifyProviderRoute } from "./worker/resolution";
import { errorText, envInt, idFrom, parseJobBigInt, randomOwner, type WorkerServices } from "./worker/shared";
import type { JobClaimFilter } from "./persistence/jobs";

const DEFAULT_LEASE_MS = 90_000;
const DEFAULT_POLL_MS = 1_500;
const DEFAULT_CONTROL_CONCURRENCY = 2;
const DEFAULT_EXTERNAL_CONCURRENCY = 2;
const MAX_LANE_CONCURRENCY = 16;
const DEFAULT_CONTROL_JOB_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_EXTERNAL_JOB_TIMEOUT_MS = 10 * 60_000;
const MAX_JOB_TIMEOUT_MS = 60 * 60_000;
const MAX_RETRIES = 8;

/**
 * Resolution and inbound-correspondence work must always retain capacity even
 * when a provider browser/API call stalls. Route verification and Skyvern
 * reconciliation can also block for minutes, so they stay in the external
 * lane rather than sharing the resolver slots.
 */
const CONTROL_JOB_TYPES = [
	"resolve_report",
	"monitor_provider_reply",
	"classify_provider_reply",
] as const satisfies readonly AbuseJobType[];

/** Jobs that may cross an external provider side-effect boundary. */
const EXTERNAL_JOB_TYPES = [
	"verify_provider",
	"reconcile_skyvern_run",
	"send_email",
	"run_portal",
	"submit_provider",
	"deliver_provider_verification_code",
] as const satisfies readonly AbuseJobType[];

const CONTROL_JOB_FILTER: JobClaimFilter = { jobTypes: CONTROL_JOB_TYPES };
const EXTERNAL_JOB_FILTER: JobClaimFilter = { jobTypes: EXTERNAL_JOB_TYPES };

class JobExecutionTimeoutError extends Error {
	readonly code = "ABUSE_JOB_TIMEOUT";

	constructor(readonly job: AbuseJob, readonly timeoutMs: number) {
		super(`Abuse job ${job.id.toString()} (${job.jobType}) exceeded its ${timeoutMs} ms execution deadline.`);
		this.name = "JobExecutionTimeoutError";
	}
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
	/** Deterministic test hook; production always dispatches through the provider registry. */
	processJob?: (job: AbuseJob, signal?: AbortSignal) => Promise<void>;
	adapter?: AbuseSkyvernAdapter;
	/** Test hook; production uses the resolver implementation above. */
	resolveTarget?: typeof resolveAbuseTarget;
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
	private adapter: AbuseSkyvernAdapter | undefined;
	private readonly resolveTarget: typeof resolveAbuseTarget;
	private readonly services: WorkerServices;
	private stopped = true;
	private loopPromises: Promise<void>[] = [];
	private readonly activeControllers = new Set<AbortController>();
	private readonly processJobOverride: AbuseWorkerOptions["processJob"];

	constructor(options: AbuseWorkerOptions = {}) {
		this.owner = options.owner ?? randomOwner();
		this.leaseMs = options.leaseMs ?? envInt("ABUSE_WORKER_LEASE_MS", DEFAULT_LEASE_MS);
		this.pollMs = options.pollMs ?? envInt("ABUSE_WORKER_POLL_MS", DEFAULT_POLL_MS);
		this.controlConcurrency = boundedConcurrency(
			options.controlConcurrency ?? envInt("ABUSE_WORKER_CONTROL_CONCURRENCY", DEFAULT_CONTROL_CONCURRENCY),
			DEFAULT_CONTROL_CONCURRENCY,
		);
		this.externalConcurrency = boundedConcurrency(
			options.externalConcurrency ?? envInt("ABUSE_WORKER_EXTERNAL_CONCURRENCY", DEFAULT_EXTERNAL_CONCURRENCY),
			DEFAULT_EXTERNAL_CONCURRENCY,
		);
		this.controlJobTimeoutMs = boundedTimeout(
			options.controlJobTimeoutMs ?? envInt("ABUSE_WORKER_CONTROL_JOB_TIMEOUT_MS", DEFAULT_CONTROL_JOB_TIMEOUT_MS),
			DEFAULT_CONTROL_JOB_TIMEOUT_MS,
		);
		this.externalJobTimeoutMs = boundedTimeout(
			options.externalJobTimeoutMs ?? envInt("ABUSE_WORKER_EXTERNAL_JOB_TIMEOUT_MS", DEFAULT_EXTERNAL_JOB_TIMEOUT_MS),
			DEFAULT_EXTERNAL_JOB_TIMEOUT_MS,
		);
		this.adapter = options.adapter;
		this.processJobOverride = options.processJob;
		this.resolveTarget = options.resolveTarget ?? resolveAbuseTarget;
		this.services = {
			owner: this.owner,
			getAdapter: () => this.getAdapter(),
			markUnknownExternal: (params) => this.markUnknownExternal(params),
		};
	}

	/**
	 * Keep the durable resolver/email worker available while the optional
	 * Skyvern sidecar is still bootstrapping. Creating the SDK client eagerly
	 * used to make a missing mounted API-key file prevent all abuse jobs from
	 * starting, including routes that never use a portal.
	 */
	private getAdapter(): AbuseSkyvernAdapter {
		if (this.adapter) return this.adapter;
		if (!process.env.SKYVERN_BASE_URL || !skyvernApiKeySourceIsConfigured()) {
			throw new Error("Skyvern is not configured for portal execution.");
		}
		this.adapter = new AbuseSkyvernAdapter();
		return this.adapter;
	}

	private async markUnknownExternal(params: { routeId: bigint; runId?: bigint; error: string; reason: string }): Promise<void> {
		await AbuseRepository.markUnknownExternalState(params);
	}

	async start(): Promise<void> {
		if (!this.stopped) return;
		this.stopped = false;
		await AbuseRepository.recoverStaleJobs();
		// Provider/browser work gets its own lane. A stuck CAPTCHA or browser can
		// therefore never consume the capacity reserved for resolution,
		// reconciliation, and inbound correspondence jobs.
		this.loopPromises = [
			...Array.from({ length: this.controlConcurrency }, (_, slot) =>
				this.runLoop(slot === 0, CONTROL_JOB_FILTER, this.controlJobTimeoutMs),
			),
			...Array.from({ length: this.externalConcurrency }, () =>
				this.runLoop(false, EXTERNAL_JOB_FILTER, this.externalJobTimeoutMs),
			),
		];
	}

	async stop(): Promise<void> {
		this.stopped = true;
		for (const controller of this.activeControllers) controller.abort(new WorkerStoppingError());
		await Promise.all(this.loopPromises);
		this.loopPromises = [];
	}

	private async maintainProviders(): Promise<void> {
		for (const provider of listPortalProviders()) await provider.maintain?.();
	}

	private async runLoop(maintainProviders: boolean, filter: JobClaimFilter, timeoutMs: number): Promise<void> {
		while (!this.stopped) {
			try {
				const processed = await this.processOne(maintainProviders, filter, timeoutMs);
				if (!processed) await new Promise((resolve) => setTimeout(resolve, this.pollMs));
			} catch (error) {
				console.error("Abuse worker loop error:", error);
				await new Promise((resolve) => setTimeout(resolve, this.pollMs));
			}
		}
	}

	async processOne(runProviderMaintenance = true, filter?: JobClaimFilter, timeoutMs?: number): Promise<boolean> {
		if (runProviderMaintenance) await this.maintainProviders();
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
			const defaultTimeout = CONTROL_JOB_TYPES.includes(job.jobType as (typeof CONTROL_JOB_TYPES)[number])
				? this.controlJobTimeoutMs
				: this.externalJobTimeoutMs;
			await this.runJobWithDeadline(job, controller, timeoutMs ?? defaultTimeout);
			await AbuseRepository.completeJob(job.id, this.owner);
		} catch (error) {
			if (error instanceof WorkerStoppingError) {
				await this.handleInterruptedJob(job, error.message, "worker_stopping");
				return true;
			}
			if (error instanceof JobExecutionTimeoutError) {
				await this.handleInterruptedJob(job, error.message, "job_execution_timeout", true);
				return true;
			}
			const message = errorText(error);
			if (job.unknownExternalState || (error as { unknownExternalState?: unknown })?.unknownExternalState === true) {
				await AbuseRepository.markJobUnknownExternalState({ jobId: job.id, owner: this.owner, error: message });
			} else if (job.retryCount >= MAX_RETRIES) {
				await this.failRetryExhaustedJob(job, message);
			} else {
				const backoff = Math.min(15 * 60_000, 1_000 * 2 ** job.retryCount);
				await AbuseRepository.retryJob({ jobId: job.id, owner: this.owner, error: message, afterMs: backoff });
			}
		} finally {
			clearInterval(heartbeat);
			this.activeControllers.delete(controller);
		}
		return true;
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
			&& EXTERNAL_JOB_TYPES.includes(job.jobType as (typeof EXTERNAL_JOB_TYPES)[number])
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
			const backoff = Math.min(15 * 60_000, 1_000 * 2 ** job.retryCount);
			await AbuseRepository.retryJob({ jobId: job.id, owner: this.owner, error: message, afterMs: backoff });
		}
	}

	private async failRetryExhaustedJob(job: AbuseJob, error: string): Promise<void> {
		// Provider-owned external actions get one chance to fence an active task
		// before generic retry exhaustion changes the route to ordinary failure.
		if (job.routeId) {
			const route = await AbuseRepository.getRoute(job.routeId);
			const provider = route ? getPortalProvider(route.providerRegistryKey) : undefined;
			if (provider?.onRetryExhausted && await provider.onRetryExhausted({
				routeId: job.routeId,
				runId: job.runId ?? undefined,
				jobType: job.jobType,
				error,
			}, this.services)) {
				await AbuseRepository.failJob({ jobId: job.id, owner: this.owner, error });
				return;
			}
		}
		// Reconciliation itself is generic transport work. A known external run
		// must never be downgraded simply because polling exhausted its retries.
		if (job.jobType === "reconcile_skyvern_run" && job.routeId) {
			const run = job.runId ? await AbuseRepository.getProviderRun(job.runId) : await AbuseRepository.getLatestActiveProviderRunForRoute(job.routeId);
			if (run?.skyvernRunId) {
				await AbuseRepository.failJob({ jobId: job.id, owner: this.owner, error });
				await this.markUnknownExternal({
					routeId: job.routeId,
					runId: run.id,
					error: `Reconciliation retries were exhausted while a Skyvern task remained externally active: ${error}`,
					reason: "skyvern_reconciliation_retry_exhausted",
				});
				return;
			}
		}
		await AbuseRepository.failJob({ jobId: job.id, owner: this.owner, error });
		if (job.routeId) {
			const route = await AbuseRepository.getRoute(job.routeId);
			if (route) {
				await AbuseRepository.transitionRouteStatus({
					routeId: route.id,
					from: ["resolving", "verified", "queued", "running", "waiting_code", "awaiting_provider_reply", "escalating_to_portal", "delivery_failed"],
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
		switch (job.jobType) {
			case "resolve_report":
				await resolveReport(idFrom(job.reportId, "reportId"), this.resolveTarget);
				return;
			case "verify_provider":
				await verifyProviderRoute(idFrom(job.routeId, "routeId"));
				return;
			case "send_email":
				await sendEmail(idFrom(job.routeId, "routeId"), this.servicesFor(signal));
				return;
			case "run_portal":
				await this.runPortal(job, signal);
				return;
			case "submit_provider":
				await this.submitProvider(idFrom(job.routeId, "routeId"), signal);
				return;
			case "reconcile_skyvern_run":
				await this.reconcilePortalRun(idFrom(job.runId, "runId"), signal);
				return;
			case "classify_provider_reply":
				await classifyReply(parseJobBigInt(job.payload?.messageId, "payload.messageId"));
				return;
			case "monitor_provider_reply":
				await monitorProviderReply(idFrom(job.routeId, "routeId"));
				return;
			case "deliver_provider_verification_code":
				await this.deliverProviderVerificationCode(job, signal);
				return;
			default:
				throw new Error(`Unsupported abuse job type ${job.jobType}.`);
		}
	}

	private servicesFor(signal?: AbortSignal): WorkerServices {
		return {
			...this.services,
			...(signal ? { signal } : {}),
		};
	}

	private async runPortal(job: AbuseJob, signal?: AbortSignal): Promise<void> {
		const routeId = idFrom(job.routeId, "routeId");
		const route = await AbuseRepository.getRoute(routeId);
		if (!route) throw new Error("Abuse route no longer exists.");
		if (route.routeType === "skyvern_portal") {
			const provider = getPortalProvider(route.providerRegistryKey);
			if (!provider) throw new Error(`No registered portal provider is available for abuse route ${route.id.toString()}.`);
			await provider.runPortal(routeId, this.servicesFor(signal));
			return;
		}
		if (route.routeType === "email") {
			await runGenericProviderPortal(routeId, job.payload ?? {}, this.servicesFor(signal));
			return;
		}
		throw new Error(`No code-owned portal adapter is available for abuse route ${route.id.toString()}.`);
	}

	/** Dispatch a direct submission exclusively through the provider registry. */
	private async submitProvider(routeId: bigint, signal?: AbortSignal): Promise<void> {
		const route = await AbuseRepository.getRoute(routeId);
		if (!route || route.routeType !== "provider_submission") return;
		const provider = getProviderSubmissionProvider(route.providerRegistryKey);
		if (!provider) {
			await AbuseRepository.transitionRouteStatus({
				routeId: route.id,
				from: ["verified", "queued", "running"],
				to: "needs_human",
				data: { reason: "provider_submission_implementation_missing" },
			});
			return;
		}
		await executeProviderSubmission({ routeId: route.id, provider, signal });
	}

	private async reconcilePortalRun(runId: bigint, signal?: AbortSignal): Promise<void> {
		const run = await AbuseRepository.getProviderRun(runId);
		if (!run) return;
		const route = await AbuseRepository.getRoute(run.routeId);
		if (!route) return;
		const provider = getPortalProvider(route.providerRegistryKey);
		if (provider) {
			await provider.reconcileRun(runId, this.servicesFor(signal));
			return;
		}
		if (route.routeType === "email") {
			await reconcileGenericSkyvern(runId, this.servicesFor(signal));
			return;
		}
		throw new Error(`No registered portal provider can reconcile abuse route ${route.id.toString()}.`);
	}

	private async deliverProviderVerificationCode(job: AbuseJob, signal?: AbortSignal): Promise<void> {
		const routeId = idFrom(job.routeId, "routeId");
		const route = await AbuseRepository.getRoute(routeId);
		if (!route) return;
		const provider = getPortalProvider(route.providerRegistryKey);
		if (!provider?.deliverVerificationCode) throw new Error(`No registered provider can deliver a verification code for abuse route ${route.id.toString()}.`);
		await provider.deliverVerificationCode({ routeId, runId: job.runId ?? undefined, payload: job.payload ?? {} }, this.servicesFor(signal));
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
