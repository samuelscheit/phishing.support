import { AbuseRepository } from "./repository";
import { resolveAbuseTarget } from "./resolver";
import { acquireFabricCdpSession, cancelFabricBrowserSession } from "../browser/fabric";
import { browserTaskModel, type ChatModel } from "../browser_task/agent";
import type { FabricCdpSessionAcquirer } from "../browser_task/fabric";
import { fabricBrowserSessionIdFromProviderPayload } from "../fabric/session";
import type { AbuseJob, AbuseJobType } from "./schema";
import {
	executeProviderSubmission,
	getProviderSubmissionProvider,
} from "./providers";
import { ensureRelayRefusalResends, readSendEmailPayload, sendEmail } from "./worker/email";
import { ensureCorrespondencePolls, pollProviderCorrespondence } from "./worker/correspondence";
import { ensureReceiptLookups, findProviderReceipt } from "./worker/receipt";
import { ensureOriginHostDisclosureJobs } from "./origin/disclosure";
import { reportOriginHostJob } from "./origin/report";
import { analyzeKitSibling } from "./origin/kit_job";
import { watchRedirector } from "./origin/redirector_watch";
import { classifyReply, monitorProviderReply } from "./worker/mail";
import { runGenericProviderPortal } from "./worker/portal";
import { resolveReport } from "./worker/resolution";
import { errorText, idFrom, parseJobBigInt, randomOwner, type WorkerServices } from "./worker/shared";
import { envInt } from "../env";
import type { JobClaimFilter } from "./persistence/jobs";
import { readInvestigationJobPayload } from "../investigation/payload";
import { releaseAfterFailedInvestigation, runReportInvestigation } from "../investigation/run";
import { setInvestigationStatus } from "../investigation/status";
import { followUpProviderDecision, readDecisionFollowUpPayload } from "./followup/decision";
import { startSamplePurgeSchedule } from "../exfiltration/downloads/sample_purge_job";
import { describeCampaignIfChanged } from "../campaign/link";
import { searchCampaignKits } from "../campaign/kit_search";
import { enqueueRulesSweep, linkSiteToCampaign } from "../campaign/sweep";
import { ensureLivenessChecks, runLivenessCheck } from "../liveness/schedule";
import { sleep } from "../sleep";

const DEFAULT_LEASE_MS = 90_000;
const DEFAULT_POLL_MS = 1_500;
const DEFAULT_CONTROL_CONCURRENCY = 2;
const DEFAULT_EXTERNAL_CONCURRENCY = 2;
const MAX_LANE_CONCURRENCY = 16;
const DEFAULT_CONTROL_JOB_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_EXTERNAL_JOB_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_SWEEP_JOB_TIMEOUT_MS = 20 * 60_000;
/**
 * An investigation's work: payload downloads with their awaited public
 * analyses, data-drop lookups, and the linked reports.
 */
const INVESTIGATION_JOB_TIMEOUT_MS = 15 * 60_000;
/** A follow-up's agent may recheck and walk the site several times; one walk alone may take 20 minutes. */
const FOLLOW_UP_JOB_TIMEOUT_MS = 60 * 60_000;
/** One site check: DNS, RDAP, and a visit of up to nine requests of 15 seconds each. */
const LIVENESS_JOB_TIMEOUT_MS = 5 * 60_000;
const MAX_JOB_TIMEOUT_MS = 60 * 60_000;
const MAX_RETRIES = 8;

/**
 * Resolution and inbound-correspondence work must always retain capacity even
 * when a provider browser/API call stalls. Route verification and browser
 * tasks can also block for minutes, so they stay in the external lane rather
 * than sharing the resolver slots.
 */
const CONTROL_JOB_TYPES = [
	"resolve_report",
	"monitor_provider_reply",
	"classify_provider_reply",
	// Read-only provider API calls, kept apart from browser and SMTP work.
	"poll_provider_correspondence",
	"find_provider_receipt",
] as const satisfies readonly AbuseJobType[];

/** Jobs that may cross an external provider side-effect boundary. */
const EXTERNAL_JOB_TYPES = [
	"send_email",
	"run_portal",
	"submit_provider",
	"investigate_report",
	"follow_up_provider_decision",
	"watch_redirector",
	// Writes a campaign's public title and summary with the model.
	"describe_campaign",
] as const satisfies readonly AbuseJobType[];

/**
 * Origin-host TLS sweeps run slice after slice for hours. One dedicated slot
 * keeps them from occupying provider capacity and keeps the scan rate of the
 * egress address bounded to one sweep at a time.
 */
const SWEEP_JOB_TYPES = ["report_origin_host"] as const satisfies readonly AbuseJobType[];

/**
 * Linking a site into its campaign (urlscan for kit files a capture did not
 * record, jsDelivr for libraries): seconds each. A slot of its own, so a site
 * just reported joins its campaign at once instead of waiting hours behind
 * the browser analyses of discovery.
 */
const LINK_JOB_TYPES = ["link_campaign"] as const satisfies readonly AbuseJobType[];

/**
 * Kit discovery: searching a campaign's kit on urlscan and the full browser
 * analysis of each site it turns up, minutes each. A search queues up to a
 * hundred analyses; one slot of their own keeps them from delaying the
 * reports being delivered and the linking of reported sites.
 */
const DISCOVERY_JOB_TYPES = ["search_campaign_kits", "analyze_kit_sibling"] as const satisfies readonly AbuseJobType[];

/**
 * Site checks run on their schedule after each report, hundreds a day. A slot
 * of their own keeps each on time instead of behind provider and browser
 * work, and keeps that work from waiting behind them.
 */
const LIVENESS_JOB_TYPES = ["check_site_liveness"] as const satisfies readonly AbuseJobType[];

const CONTROL_JOB_FILTER: JobClaimFilter = { jobTypes: CONTROL_JOB_TYPES };
const EXTERNAL_JOB_FILTER: JobClaimFilter = { jobTypes: EXTERNAL_JOB_TYPES };
const SWEEP_JOB_FILTER: JobClaimFilter = { jobTypes: SWEEP_JOB_TYPES };
const LINK_JOB_FILTER: JobClaimFilter = { jobTypes: LINK_JOB_TYPES };
const DISCOVERY_JOB_FILTER: JobClaimFilter = { jobTypes: DISCOVERY_JOB_TYPES };
const LIVENESS_JOB_FILTER: JobClaimFilter = { jobTypes: LIVENESS_JOB_TYPES };

/** The longest any error may ask a job to wait before its next attempt. */
const MAX_RETRY_AFTER_MS = 60 * 60_000;

/**
 * How long a failed job waits before its next attempt: exponential backoff,
 * or longer when the error says when its dependency can be tried again
 * (`retryAfterMs`, e.g. a provider login that is backing off). Retrying
 * sooner would only replay that failure and spend the job's retries.
 */
export function retryDelayMs(error: unknown, retryCount: number): number {
	const backoff = Math.min(15 * 60_000, 1_000 * 2 ** retryCount);
	const retryAfterMs = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
	if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs)) return backoff;
	return Math.max(backoff, Math.min(Math.ceil(retryAfterMs), MAX_RETRY_AFTER_MS));
}

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
	/** Test hook: the model that drives browser tasks (production reads PHISHING_TASK_MODEL). */
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
		this.sweepJobTimeoutMs = boundedTimeout(
			options.sweepJobTimeoutMs ?? envInt("ABUSE_WORKER_SWEEP_JOB_TIMEOUT_MS", DEFAULT_SWEEP_JOB_TIMEOUT_MS),
			DEFAULT_SWEEP_JOB_TIMEOUT_MS,
		);
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
		this.loopPromises = [
			...Array.from({ length: this.controlConcurrency }, () => this.runLoop(CONTROL_JOB_FILTER, this.controlJobTimeoutMs)),
			...Array.from({ length: this.externalConcurrency }, () => this.runLoop(EXTERNAL_JOB_FILTER, this.externalJobTimeoutMs)),
			this.runLoop(SWEEP_JOB_FILTER, this.sweepJobTimeoutMs),
			this.runLoop(LINK_JOB_FILTER, this.externalJobTimeoutMs),
			this.runLoop(DISCOVERY_JOB_FILTER, this.externalJobTimeoutMs),
			this.runLoop(LIVENESS_JOB_FILTER, LIVENESS_JOB_TIMEOUT_MS),
		];
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

	private async runLoop(filter: JobClaimFilter, timeoutMs: number): Promise<void> {
		while (!this.stopped) {
			try {
				const processed = await this.processOne(filter, timeoutMs);
				if (!processed) await sleep(this.pollMs);
			} catch (error) {
				console.error("Abuse worker loop error:", error);
				await sleep(this.pollMs);
			}
		}
	}

	async processOne(filter?: JobClaimFilter, timeoutMs?: number): Promise<boolean> {
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
				: SWEEP_JOB_TYPES.includes(job.jobType as (typeof SWEEP_JOB_TYPES)[number])
					? this.sweepJobTimeoutMs
					: job.jobType === "investigate_report"
						? Math.max(this.externalJobTimeoutMs, INVESTIGATION_JOB_TIMEOUT_MS)
						: job.jobType === "follow_up_provider_decision"
							? Math.max(this.externalJobTimeoutMs, FOLLOW_UP_JOB_TIMEOUT_MS)
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
			} else if (isNonRetryableError(error)) {
				// A verdict that repeating the same work cannot change: fail now rather than
				// spend the remaining retries on identical browser tasks.
				await this.failRetryExhaustedJob(job, message);
			} else if (job.retryCount >= MAX_RETRIES) {
				await this.failRetryExhaustedJob(job, message);
			} else {
				await AbuseRepository.retryJob({ jobId: job.id, owner: this.owner, error: message, afterMs: retryDelayMs(error, job.retryCount) });
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
		if (job.jobType === "investigate_report") {
			// Evidence gathering is supplementary. Its failure must never keep the
			// confirmed site from being reported: the report goes out without it.
			await AbuseRepository.failJob({ jobId: job.id, owner: this.owner, error });
			if (job.reportId) {
				const report = await AbuseRepository.getReport(job.reportId);
				await releaseAfterFailedInvestigation(job.reportId, report?.submissionId ?? undefined, error);
			}
			return;
		}
		if (["report_origin_host", "link_campaign", "describe_campaign", "search_campaign_kits", "analyze_kit_sibling", "watch_redirector", "check_site_liveness"].includes(job.jobType)) {
			// Infrastructure, campaigns, kit discovery and site checks are supplementary follow-up.
			// Failure must not turn a successfully submitted phishing report into a reporting failure.
			await AbuseRepository.failJob({ jobId: job.id, owner: this.owner, error });
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
		switch (job.jobType) {
			case "resolve_report":
				await resolveReport(idFrom(job.reportId, "reportId"), this.resolveTarget, job.retryCount);
				return;
			case "send_email":
				await sendEmail(idFrom(job.routeId, "routeId"), this.servicesFor(signal), readSendEmailPayload(job.payload));
				return;
			case "run_portal":
				await this.runPortal(job, signal);
				return;
			case "submit_provider":
				await this.submitProvider(idFrom(job.routeId, "routeId"), signal);
				return;
			case "classify_provider_reply":
				await classifyReply(parseJobBigInt(job.payload?.messageId, "payload.messageId"));
				return;
			case "poll_provider_correspondence":
				await pollProviderCorrespondence({ routeId: idFrom(job.routeId, "routeId"), jobId: job.id, signal });
				return;
			case "find_provider_receipt":
				await findProviderReceipt({ runId: idFrom(job.runId, "runId"), jobId: job.id, signal });
				return;
			case "monitor_provider_reply":
				await monitorProviderReply(idFrom(job.routeId, "routeId"));
				return;
			case "investigate_report":
				await this.runInvestigationJob(job, signal);
				return;
			case "follow_up_provider_decision":
				await followUpProviderDecision({ routeId: idFrom(job.routeId, "routeId"), ...readDecisionFollowUpPayload(job.payload) }, signal ? { signal } : {});
				return;
			case "report_origin_host":
				await reportOriginHostJob(job, idFrom(job.reportId, "reportId"), signal);
				return;
			case "search_campaign_kits":
				await searchCampaignKits({ job, signal });
				return;
			case "analyze_kit_sibling":
				await analyzeKitSibling({ reportId: idFrom(job.reportId, "reportId"), url: job.payload?.url, hashes: job.payload?.hashes, signal });
				return;
			case "watch_redirector":
				await watchRedirector({ job, signal });
				return;
			case "link_campaign":
				await linkSiteToCampaign({ submissionId: parseJobBigInt(job.payload?.submissionId, "payload.submissionId"), reportId: idFrom(job.reportId, "reportId") });
				return;
			case "describe_campaign":
				await describeCampaignIfChanged(parseJobBigInt(job.payload?.campaignId, "payload.campaignId"));
				return;
			case "check_site_liveness":
				await runLivenessCheck({ jobId: job.id, targetId: parseJobBigInt(job.payload?.targetId, "payload.targetId"), dependencies: signal ? { signal } : {} });
				return;
			default:
				throw new Error(`Unsupported abuse job type ${job.jobType}.`);
		}
	}

	private async runInvestigationJob(job: AbuseJob, signal?: AbortSignal): Promise<void> {
		const reportId = idFrom(job.reportId, "reportId");
		const report = await AbuseRepository.getReport(reportId);
		if (!report?.submissionId) return;
		const payload = readInvestigationJobPayload(job.payload);
		try {
			await this.investigateReport({
				reportId,
				payload,
				reporter: {
					reporterIp: report.requesterIp ?? undefined,
					reporterCountry: report.requesterCountry ?? undefined,
					reporterHeaders: report.requesterHeaders ?? undefined,
				},
				...(signal ? { signal } : {}),
			});
		} catch (error) {
			// The worker decides finality: a retryable failure is queued again, and a
			// terminal one releases the report on its single terminal path.
			await setInvestigationStatus(report.submissionId, { status: "queued", lastError: errorText(error), updatedAt: new Date().toISOString() });
			throw error;
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
