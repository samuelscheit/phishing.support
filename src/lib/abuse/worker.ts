import { AbuseRepository } from "./repository";
import { resolveAbuseTarget } from "./resolver";
import { AbuseSkyvernAdapter } from "./skyvern";
import { skyvernApiKeySourceIsConfigured } from "./skyvern_config";
import type { AbuseJob } from "./schema";
import { sendEmail } from "./worker/email";
import { maintainUnknownGnameLocks, runGnamePortal as runGnamePortalTask, sendTotpCode } from "./worker/gname";
import { classifyReply, monitorProviderReply } from "./worker/mail";
import { reconcileSkyvern, runGenericProviderPortal } from "./worker/portal";
import { resolveReport, verifyGname } from "./worker/resolution";
import { errorText, envInt, idFrom, parseJobBigInt, randomOwner, type WorkerServices } from "./worker/shared";

const DEFAULT_LEASE_MS = 90_000;
const DEFAULT_POLL_MS = 1_500;
const MAX_RETRIES = 8;

export type AbuseWorkerOptions = {
	owner?: string;
	leaseMs?: number;
	pollMs?: number;
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
	private adapter: AbuseSkyvernAdapter | undefined;
	private readonly resolveTarget: typeof resolveAbuseTarget;
	private readonly services: WorkerServices;
	private stopped = true;
	private loopPromise: Promise<void> | undefined;

	constructor(options: AbuseWorkerOptions = {}) {
		this.owner = options.owner ?? randomOwner();
		this.leaseMs = options.leaseMs ?? envInt("ABUSE_WORKER_LEASE_MS", DEFAULT_LEASE_MS);
		this.pollMs = options.pollMs ?? envInt("ABUSE_WORKER_POLL_MS", DEFAULT_POLL_MS);
		this.adapter = options.adapter;
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
		this.loopPromise = this.runLoop();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		await this.loopPromise;
		this.loopPromise = undefined;
	}

	private async runLoop(): Promise<void> {
		while (!this.stopped) {
			try {
				const processed = await this.processOne();
				if (!processed) await new Promise((resolve) => setTimeout(resolve, this.pollMs));
			} catch (error) {
				console.error("Abuse worker loop error:", error);
				await new Promise((resolve) => setTimeout(resolve, this.pollMs));
			}
		}
	}

	async processOne(): Promise<boolean> {
		await maintainUnknownGnameLocks();
		const job = await AbuseRepository.claimNextJob(this.owner, this.leaseMs);
		if (!job) return false;
		const heartbeat = setInterval(() => {
			void AbuseRepository.renewJobLease(job.id, this.owner, this.leaseMs);
		}, Math.max(1_000, Math.floor(this.leaseMs / 3)));
		try {
			await this.processJob(job);
			await AbuseRepository.completeJob(job.id, this.owner);
		} catch (error) {
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
		}
		return true;
	}

	private async failRetryExhaustedJob(job: AbuseJob, error: string): Promise<void> {
		// A known Skyvern task can still be executing even if local reads/code
		// delivery remain unavailable. Do not downgrade that route to ordinary
		// failure and accidentally free the shared GNAME mailbox for another run.
		if ((job.jobType === "reconcile_skyvern_run" || job.jobType === "send_totp_code") && job.routeId) {
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

	private async processJob(job: AbuseJob): Promise<void> {
		switch (job.jobType) {
			case "resolve_report":
				await resolveReport(idFrom(job.reportId, "reportId"), this.resolveTarget);
				return;
			case "verify_gname":
				await verifyGname(idFrom(job.routeId, "routeId"));
				return;
			case "send_email":
				await sendEmail(idFrom(job.routeId, "routeId"), this.services);
				return;
			case "run_portal":
				await this.runPortal(job);
				return;
			case "reconcile_skyvern_run":
				await reconcileSkyvern(idFrom(job.runId, "runId"), this.services);
				return;
			case "classify_provider_reply":
				await classifyReply(parseJobBigInt(job.payload?.messageId, "payload.messageId"));
				return;
			case "monitor_provider_reply":
				await monitorProviderReply(idFrom(job.routeId, "routeId"));
				return;
			case "send_totp_code":
				await sendTotpCode(job, this.services);
				return;
			default:
				throw new Error(`Unsupported abuse job type ${job.jobType}.`);
		}
	}

	private async runPortal(job: AbuseJob): Promise<void> {
		const routeId = idFrom(job.routeId, "routeId");
		const route = await AbuseRepository.getRoute(routeId);
		if (!route) throw new Error("Abuse route no longer exists.");
		if (route.routeType === "skyvern_portal" && route.providerRegistryKey === "gname") {
			await this.runGnamePortal(routeId);
			return;
		}
		if (route.routeType === "email") {
			await runGenericProviderPortal(routeId, job.payload ?? {}, this.services);
			return;
		}
		throw new Error(`No code-owned portal adapter is available for abuse route ${route.id.toString()}.`);
	}

	// Retained as a narrow forwarding seam for the existing focused durability tests.
	private async runGnamePortal(routeId: bigint): Promise<void> {
		await runGnamePortalTask(routeId, this.services);
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
