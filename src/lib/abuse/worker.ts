import crypto from "node:crypto";

import { AbuseRepository } from "./repository";
import { resolveAbuseTarget } from "./resolver";
import { getProviderDefinition, gnameServiceIdentity, isGenericEmailRouteEnabled, isGenericFormEscalationEnabled, isProviderRouteEnabled, providerDefinitionMatchesPin, verifiedDomainsForEmailRoute } from "./registry";
import { verifyGnameRoute } from "./verification";
import { makeProviderDescription } from "./evidence";
import { sendAbuseEmailRoute, classifyProviderReply, extractVerifiedProviderLinks, extractUnambiguousVerificationCode, isSafeEmailDeliveryFailure, resolveVerifiedProviderLink } from "./mail";
import { AbuseSkyvernAdapter, buildGenericProviderFormTaskPayload, buildGnameTaskPayload, isSafeSkyvernStorageUrl, isTerminalSkyvernStatus, validateSkyvernOutputContract, type SkyvernTaskPayload } from "./skyvern";
import { stableJson } from "./security";
import { skyvernApiKeySourceIsConfigured } from "./skyvern_config";
import type { AbuseJob } from "./schema";

const DEFAULT_LEASE_MS = 90_000;
const DEFAULT_POLL_MS = 1_500;
const MAX_RETRIES = 8;
const GNAME_CODE_LOCK_PREFIX = "abuse:gname:shared-mailbox:";

function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function envInt(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function idFrom(value: bigint | null | undefined, name: string): bigint {
	if (value === null || value === undefined) throw new Error(`Abuse job is missing ${name}.`);
	return value;
}

function randomOwner(): string {
	return `${process.pid}-${crypto.randomBytes(10).toString("hex")}`;
}

/**
 * An external call can have succeeded even when its HTTP response was lost.
 * Such a job must stop permanently until an operator or a reconciliation
 * action resolves it; retrying it blindly could duplicate a provider report.
 */
class UnknownExternalStateError extends Error {
	readonly unknownExternalState = true;
}

/** An SMTP rejection before a durable provider acceptance is safe to retry. */
class RetryableDeliveryError extends Error {}

function parseJobBigInt(value: unknown, name: string): bigint {
	if (typeof value === "bigint") return value;
	if (typeof value !== "string" && typeof value !== "number") throw new Error(`Abuse job is missing ${name}.`);
	try {
		const parsed = BigInt(value);
		if (parsed < 0n) throw new Error();
		return parsed;
	} catch {
		throw new Error(`Abuse job has an invalid ${name}.`);
	}
}

function parseOptionalBigInt(value: unknown): bigint | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	try {
		const parsed = BigInt(value as string | number | bigint);
		return parsed >= 0n ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Accept only a standalone, bounded numeric token; never execute mail text. */
function extractVerificationCode(text: string): string | undefined {
	return extractUnambiguousVerificationCode(text);
}

function gnameCodeLockKey(mailbox: string): string {
	return `${GNAME_CODE_LOCK_PREFIX}${mailbox.toLowerCase()}`;
}

function gnameCodeLockOwner(routeId: bigint): string {
	return `abuse:gname:route:${routeId.toString()}`;
}

/** Short-lived per-route lease prevents stale workers from replaying uploads. */
function gnamePreparationLockKey(routeId: bigint): string {
	return `abuse:gname:portal-preparation:${routeId.toString()}`;
}

/**
 * Unlike the GNAME mailbox lock, generic portals do not share a physical
 * resource. They still need a unique owner around task creation so a stale
 * job cannot mistake a live worker's durable pre-call marker for a crash.
 */
function portalTaskCreationLockKey(routeId: bigint): string {
	return `abuse:portal-task-creation:${routeId.toString()}`;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Read only a payload shape that this service itself persisted before an SDK call. */
function storedSkyvernTaskPayload(value: unknown): SkyvernTaskPayload | undefined {
	const task = recordValue(value);
	if (!task || typeof task.prompt !== "string" || typeof task.url !== "string" || !Number.isFinite(task.max_steps) || !recordValue(task.data_extraction_schema)) {
		return undefined;
	}
	try {
		const url = new URL(task.url);
		if (url.protocol !== "https:" || url.username || url.password) return undefined;
	} catch {
		return undefined;
	}
	return task as unknown as SkyvernTaskPayload;
}

type GnameEvidenceSource = {
	id: string;
	name: string;
	mimeType: string;
	sha256: string;
	size: number;
};

type GnameEvidenceUpload = {
	artifactId: string;
	sha256: string;
	state: "pending" | "upload_started" | "uploaded";
	startedAt?: string;
	presignedUrl?: string;
	uploadedAt?: string;
	expiresAt?: string;
};

type GnameTaskInput = {
	entryUrl: string;
	description: string;
	domains: string[];
	observedUrls: string[];
	serviceName: string;
	legalBrandUrl: string;
	serviceMailbox: string;
	webhookUrl?: string;
	totpIdentifier?: string;
};

function stringArray(value: unknown, maximum: number): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > maximum || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 4_096)) {
		return undefined;
	}
	return [...value] as string[];
}

function storedGnameTaskInput(providerPayload: Record<string, unknown>): GnameTaskInput | undefined {
	const input = recordValue(providerPayload.taskInput);
	if (!input
		|| typeof input.entryUrl !== "string"
		|| typeof input.description !== "string" || input.description.length > 1_000
		|| typeof input.serviceName !== "string" || input.serviceName.length === 0 || input.serviceName.length > 500
		|| typeof input.legalBrandUrl !== "string" || input.legalBrandUrl.length === 0 || input.legalBrandUrl.length > 4_096
		|| typeof input.serviceMailbox !== "string" || input.serviceMailbox.length === 0 || input.serviceMailbox.length > 320
		|| (input.webhookUrl !== undefined && typeof input.webhookUrl !== "string")
		|| (input.totpIdentifier !== undefined && typeof input.totpIdentifier !== "string")) {
		return undefined;
	}
	const domains = stringArray(input.domains, 100);
	const observedUrls = stringArray(input.observedUrls, 100);
	if (!domains || !observedUrls) return undefined;
	return {
		entryUrl: input.entryUrl,
		description: input.description,
		domains,
		observedUrls,
		serviceName: input.serviceName,
		legalBrandUrl: input.legalBrandUrl,
		serviceMailbox: input.serviceMailbox,
		webhookUrl: input.webhookUrl,
		totpIdentifier: input.totpIdentifier,
	};
}

function storedGnameEvidenceSources(providerPayload: Record<string, unknown>): GnameEvidenceSource[] | undefined {
	if (!Array.isArray(providerPayload.sourceArtifacts) || providerPayload.sourceArtifacts.length === 0) return undefined;
	const sources: GnameEvidenceSource[] = [];
	for (const value of providerPayload.sourceArtifacts) {
		const source = recordValue(value);
		if (!source
			|| typeof source.id !== "string" || !/^\d+$/.test(source.id)
			|| typeof source.name !== "string" || source.name.length === 0 || source.name.length > 180
			|| (source.mimeType !== "image/jpeg" && source.mimeType !== "image/png")
			|| typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(source.sha256)
			|| typeof source.size !== "number" || !Number.isSafeInteger(source.size) || source.size <= 0) {
			return undefined;
		}
		sources.push({
			id: source.id,
			name: source.name,
			mimeType: source.mimeType,
			sha256: source.sha256.toLowerCase(),
			size: source.size,
		});
	}
	return new Set(sources.map((source) => source.id)).size === sources.length ? sources : undefined;
}

function validIsoTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
 * Every SDK file upload gets its own durable pre-call marker. A process that
 * dies after marking an upload started cannot know whether Skyvern accepted
 * it, so a later worker must fail closed rather than upload the same evidence
 * again. Completed URLs are intentionally bounded in age: a retry must never
 * silently substitute a fresh upload after a presigned URL may have expired.
 */
function storedGnameEvidenceUploads(
	providerPayload: Record<string, unknown>,
	sources: GnameEvidenceSource[],
): GnameEvidenceUpload[] | undefined {
	if (!Array.isArray(providerPayload.evidenceUploads) || providerPayload.evidenceUploads.length !== sources.length) return undefined;
	const uploads: GnameEvidenceUpload[] = [];
	for (const [index, value] of providerPayload.evidenceUploads.entries()) {
		const candidate = recordValue(value);
		const source = sources[index];
		if (!candidate || !source
			|| candidate.artifactId !== source.id
			|| candidate.sha256 !== source.sha256
			|| !["pending", "upload_started", "uploaded"].includes(candidate.state as string)) {
			return undefined;
		}
		const state = candidate.state as GnameEvidenceUpload["state"];
		if (state === "pending") {
			if (candidate.startedAt !== undefined || candidate.presignedUrl !== undefined || candidate.uploadedAt !== undefined || candidate.expiresAt !== undefined) return undefined;
			uploads.push({ artifactId: source.id, sha256: source.sha256, state });
			continue;
		}
		if (state === "upload_started") {
			if (!validIsoTimestamp(candidate.startedAt) || candidate.presignedUrl !== undefined || candidate.uploadedAt !== undefined || candidate.expiresAt !== undefined) return undefined;
			uploads.push({ artifactId: source.id, sha256: source.sha256, state, startedAt: candidate.startedAt });
			continue;
		}
		if (typeof candidate.presignedUrl !== "string" || !isSafeSkyvernStorageUrl(candidate.presignedUrl)
			|| !validIsoTimestamp(candidate.uploadedAt) || !validIsoTimestamp(candidate.expiresAt)
			|| Date.parse(candidate.expiresAt) <= Date.parse(candidate.uploadedAt)) {
			return undefined;
		}
		uploads.push({
			artifactId: source.id,
			sha256: source.sha256,
			state,
			presignedUrl: candidate.presignedUrl,
			uploadedAt: candidate.uploadedAt,
			expiresAt: candidate.expiresAt,
		});
	}
	return uploads;
}

function queryParam(url: URL, name: string): string | undefined {
	for (const [key, value] of url.searchParams) if (key.toLowerCase() === name.toLowerCase()) return value;
	return undefined;
}

function gnameEvidenceUploadDeadline(presignedUrl: string, uploadedAt: Date): Date {
	const maximumAgeMs = envInt("ABUSE_GNAME_UPLOAD_URL_MAX_AGE_MS", 10 * 60_000);
	const fallback = uploadedAt.getTime() + maximumAgeMs;
	let deadline = fallback;
	try {
		const url = new URL(presignedUrl);
		const expires = queryParam(url, "expires");
		if (expires && /^\d{10,13}$/.test(expires)) {
			const epoch = Number(expires) * (expires.length === 10 ? 1_000 : 1);
			if (Number.isSafeInteger(epoch)) deadline = Math.min(deadline, epoch);
		}
		const amzDate = queryParam(url, "x-amz-date");
		const amzExpires = queryParam(url, "x-amz-expires");
		const match = amzDate?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
		if (match && amzExpires && /^\d{1,8}$/.test(amzExpires)) {
			const signedAt = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
			const candidate = signedAt + Number(amzExpires) * 1_000;
			if (Number.isSafeInteger(candidate)) deadline = Math.min(deadline, candidate);
		}
	} catch {
		// URL safety was checked before this helper. Retain the conservative
		// fallback in case a storage provider uses an opaque URL shape.
	}
	return new Date(deadline);
}

export type AbuseWorkerOptions = {
	owner?: string;
	leaseMs?: number;
	pollMs?: number;
	adapter?: AbuseSkyvernAdapter;
	/** Test hook; production uses the resolver implementation above. */
	resolveTarget?: typeof resolveAbuseTarget;
};

export class AbuseWorker {
	private readonly owner: string;
	private readonly leaseMs: number;
	private readonly pollMs: number;
	private adapter: AbuseSkyvernAdapter | undefined;
	private readonly resolveTarget: typeof resolveAbuseTarget;
	private stopped = true;
	private loopPromise: Promise<void> | undefined;

	constructor(options: AbuseWorkerOptions = {}) {
		this.owner = options.owner ?? randomOwner();
		this.leaseMs = options.leaseMs ?? envInt("ABUSE_WORKER_LEASE_MS", DEFAULT_LEASE_MS);
		this.pollMs = options.pollMs ?? envInt("ABUSE_WORKER_POLL_MS", DEFAULT_POLL_MS);
		this.adapter = options.adapter;
		this.resolveTarget = options.resolveTarget ?? resolveAbuseTarget;
	}

	/**
	 * Keep the durable resolver/email worker available while the optional
	 * Skyvern sidecar is still bootstrapping.  Creating the SDK client eagerly
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

	/**
	 * An unknown GNAME task must continue to reserve the shared mailbox even
	 * after its ordinary lease expires.  The route-level blocker prevents a
	 * second task from starting; this renewal also keeps the physical lock alive
	 * across worker restarts while operations reconcile the external task.
	 */
	private async maintainUnknownGnameLocks(): Promise<void> {
		const identity = gnameServiceIdentity();
		if (!identity.mailbox) return;
		const leaseMs = envInt("ABUSE_GNAME_CODE_LOCK_MS", 75 * 60_000);
		const routes = await AbuseRepository.listActiveGnameRoutes();
		for (const route of routes) {
			if (route.status !== "unknown_external_state") continue;
			await AbuseRepository.acquireOrRenewGnameMailboxLock({
				routeId: route.id,
				lockKey: gnameCodeLockKey(identity.mailbox),
				owner: gnameCodeLockOwner(route.id),
				leaseMs,
			});
		}
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
		await this.maintainUnknownGnameLocks();
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
				await this.resolveReport(idFrom(job.reportId, "reportId"));
				return;
			case "verify_gname":
				await this.verifyGname(idFrom(job.routeId, "routeId"));
				return;
			case "send_email":
				await this.sendEmail(idFrom(job.routeId, "routeId"));
				return;
			case "run_portal":
				await this.runPortal(job);
				return;
			case "reconcile_skyvern_run":
				await this.reconcileSkyvern(idFrom(job.runId, "runId"));
				return;
			case "classify_provider_reply":
				await this.classifyReply(parseJobBigInt(job.payload?.messageId, "payload.messageId"));
				return;
			case "monitor_provider_reply":
				await this.monitorProviderReply(idFrom(job.routeId, "routeId"));
				return;
			case "send_totp_code":
				await this.sendTotpCode(job);
				return;
			default:
				throw new Error(`Unsupported abuse job type ${job.jobType}.`);
		}
	}

	private async resolveReport(reportId: bigint): Promise<void> {
		const input = await AbuseRepository.getReportInput(reportId);
		if (!input) throw new Error("Abuse report no longer exists.");
		// A resolver job can be replayed after a lease expiry. Once another
		// worker has moved the report into verification/execution or a terminal
		// aggregate, this old job must not reopen it or enqueue duplicate work.
		if (!["accepted", "resolving"].includes(input.report.status)) return;
		if (input.report.status === "accepted") {
			await AbuseRepository.transitionReportStatus({ reportId, from: "accepted", to: "resolving" });
		}
		for (const target of input.targets) {
			const resolved = await this.resolveTarget({
				normalizedTarget: target.normalizedTarget,
				targetType: target.targetType,
				observedUrls: target.observedUrls,
			});
			await AbuseRepository.setTargetResolution({
				targetId: target.id,
				status: resolved.status,
				resolverSnapshot: resolved.resolverSnapshot,
				disposition: resolved.disposition,
			});
			for (const routeInput of resolved.routes) {
				const route = await AbuseRepository.upsertResolvedRoute(target.id, routeInput);
				if (route.status === "resolving" && route.routeType === "skyvern_portal") {
					await AbuseRepository.enqueueJob({
						jobType: "verify_gname",
						reportId,
						routeId: route.id,
						payload: {},
						dedupeKey: `verify:${route.id.toString()}`,
					});
				} else if (route.status === "verified" && route.routeType === "email") {
					await AbuseRepository.enqueueJob({
						jobType: "send_email",
						reportId,
						routeId: route.id,
						payload: {},
						dedupeKey: `email:${route.id.toString()}`,
					});
				}
			}
		}
		await AbuseRepository.recomputeReportStatus(reportId);
	}

	private async routeContext(routeId: bigint) {
		const route = await AbuseRepository.getRoute(routeId);
		if (!route) throw new Error("Abuse route no longer exists.");
		const input = await AbuseRepository.getReportInput(route.reportId);
		if (!input) throw new Error("Abuse report no longer exists.");
		const target = input.targets.find((item) => item.id === route.targetId);
		if (!target) throw new Error("Abuse route target no longer exists.");
		return { route, ...input, target };
	}

	private async verifyGname(routeId: bigint): Promise<void> {
		const { route, report, target, evidenceArtifacts } = await this.routeContext(routeId);
		// Verification recaptures external evidence. A stale job must never do
		// that after the route has already been queued, submitted, or blocked.
		if (route.routeType !== "skyvern_portal" || route.providerRegistryKey !== "gname" || route.status !== "resolving") return;
		const definition = getProviderDefinition("gname");
		if (!definition || !providerDefinitionMatchesPin(definition, route.providerDefinitionVersion, route.providerDefinitionHash)) {
			await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "resolving", to: "needs_human", data: { reason: "provider_definition_pin_mismatch" } });
			return;
		}
		if (!isProviderRouteEnabled(definition)) {
			await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "resolving", to: "no_route", data: { reason: "provider_route_disabled" } });
			return;
		}
		await AbuseRepository.transitionReportStatus({ reportId: report.id, from: ["resolving", "verifying"], to: "verifying" });
		const userEvidence = evidenceArtifacts.map((artifact) => ({
			filename: artifact.name,
			mimeType: artifact.mimeType as "image/jpeg" | "image/png" | "image/webp",
			buffer: artifact.blob,
			sha256: artifact.sha256,
		}));
		const result = await verifyGnameRoute({
			target: target.normalizedTarget,
			observedUrls: target.observedUrls,
			legalBrandUrl: report.legalBrandUrl ?? undefined,
			description: report.description,
			userEvidence,
		});
		if (!(await AbuseRepository.setRouteVerification(route.id, result.result, gnameServiceIdentity(), "resolving"))) return;
		for (const capture of result.captures) {
			await AbuseRepository.saveArtifact({
				reportId: report.id,
				targetId: target.id,
				routeId: route.id,
				name: `capture-${new URL(capture.url).hostname}.jpg`,
				kind: "service_browser_capture",
				mimeType: capture.mimeType,
				buffer: capture.screenshot,
				metadata: capture.metadata,
			});
		}
		for (const derivative of result.derivatives) {
			await AbuseRepository.saveArtifact({
				reportId: report.id,
				targetId: target.id,
				routeId: route.id,
				name: derivative.name,
				kind: "provider_evidence_derivative",
				mimeType: derivative.mimeType,
				buffer: derivative.buffer,
				metadata: derivative.metadata,
			});
		}
		if (!result.passed) {
			const reasons = Array.isArray(result.result.reasons) ? result.result.reasons : [];
			// All GNAME preconditions, including the service identity, are evidence
			// contract requirements. `needs_human` is reserved for a material live
			// form/output drift, never for a missing configuration prerequisite.
			await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "resolving", to: "insufficient_evidence", data: { reasons } });
			return;
		}
		if (await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "resolving", to: "queued" })) {
			await AbuseRepository.enqueueJob({ jobType: "run_portal", reportId: report.id, routeId: route.id, payload: {}, dedupeKey: `portal:${route.id.toString()}` });
		}
	}

	private async sendEmail(routeId: bigint): Promise<void> {
		const { route, report, target, evidenceArtifacts } = await this.routeContext(routeId);
		if (route.routeType !== "email" || !route.verifiedEmail) return;
		if (!["verified", "delivery_failed"].includes(route.status)) return;
		if (!isGenericEmailRouteEnabled()) {
			await AbuseRepository.transitionRouteStatus({
				routeId: route.id,
				from: ["verified", "delivery_failed"],
				to: "no_route",
				data: { reason: "generic_email_route_disabled" },
			});
			return;
		}
		const correlationKey = `email-run:${route.id.toString()}`;
		const delivery = await AbuseRepository.beginEmailDelivery({
			routeId: route.id,
			correlationKey,
			providerPayload: {
				kind: "verified_email_report",
				target: target.normalizedTarget,
				description: report.description,
				observedUrls: target.observedUrls,
				recipient: route.verifiedEmail,
			},
		});
		if (!delivery) return;
		const run = delivery.run;
		let retryReplyAddress: string | undefined;
		if (!delivery.created) {
			const outbound = await AbuseRepository.getOutboundMailForRun(run.id);
			if (delivery.previousDeliveryFailed && outbound?.status === "failed") {
				// SMTP explicitly reported the prior delivery failure. Retrying that
				// outcome is safe only with the same durable correlation/reply identity.
				retryReplyAddress = outbound.replyAddress ?? undefined;
			} else {
				const message = "Email delivery was interrupted after its durable run record was created; resend is unsafe without delivery reconciliation.";
				await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "outbound_delivery_interrupted" });
				throw new UnknownExternalStateError(message);
			}
		}
		const attachments = evidenceArtifacts.slice(0, 15).map((artifact) => ({ filename: artifact.name, mimeType: artifact.mimeType, content: artifact.blob }));
		let result: Awaited<ReturnType<typeof sendAbuseEmailRoute>>;
		try {
			result = await sendAbuseEmailRoute({
				routeId: route.id,
				runId: run.id,
				reportId: report.id,
				recipient: route.verifiedEmail,
				subject: `[Phishing Support] Abuse report for ${target.normalizedTarget}`,
				body: `Target: ${target.normalizedTarget}\nObserved URLs: ${target.observedUrls.join("\n")}\n\n${report.description}`,
				attachments,
				correlationKey,
				replyAddress: retryReplyAddress,
			});
		} catch (error) {
			// MIME construction, local artifact persistence, and outbound-message
			// persistence all happen before SMTP. Those failures are therefore
			// safely retryable, but only after the claimed route/run are atomically
			// returned to the known delivery-failed state. Do not let a normal job
			// retry strand this route in `running`.
			const failure = errorText(error);
			if (isSafeEmailDeliveryFailure(error) && await AbuseRepository.recoverEmailPreparationFailure({ runId: run.id, error: failure })) {
				throw new RetryableDeliveryError(failure);
			}

			// A correlated bounce can settle the same run between local persistence
			// and this catch block. That is a stronger, known outcome; leave its
			// durable retry job in charge instead of downgrading it to an ambiguity.
			const [currentRun, currentRoute] = await Promise.all([
				AbuseRepository.getProviderRun(run.id),
				AbuseRepository.getRoute(route.id),
			]);
			if (currentRun?.executionStatus === "failed" && currentRoute?.status === "delivery_failed") return;

			const message = `Email delivery failed after the route was claimed but could not be safely recovered: ${failure}`;
			await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "email_preparation_recovery_conflict" });
			throw new UnknownExternalStateError(message);
		}
		if (result.status === "sent") {
			if (await AbuseRepository.settleEmailDelivery({
				runId: run.id,
				expectedRunStatus: "starting",
				expectedRouteStatus: "running",
				outcome: "sent",
			})) {
				await AbuseRepository.enqueueJob({ jobType: "monitor_provider_reply", reportId: report.id, routeId: route.id, runId: run.id, payload: {}, dedupeKey: `monitor:${run.id.toString()}`, nextAttemptAt: new Date(Date.now() + 24 * 60 * 60_000) });
			}
		} else if (result.status === "unknown_external_state") {
			const message = `SMTP delivery may have crossed the provider boundary: ${result.error ?? "transport response was lost"}`;
			await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "smtp_delivery_ambiguous" });
			throw new UnknownExternalStateError(message);
		} else {
			await AbuseRepository.settleEmailDelivery({
				runId: run.id,
				expectedRunStatus: "starting",
				expectedRouteStatus: "running",
				outcome: "failed",
				failureReason: result.error,
			});
			throw new RetryableDeliveryError(result.error ?? "SMTP delivery was rejected before provider acceptance.");
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
			await this.runGenericProviderPortal(routeId, job.payload ?? {});
			return;
		}
		throw new Error(`No code-owned portal adapter is available for abuse route ${route.id.toString()}.`);
	}

	private async runGnamePortal(routeId: bigint): Promise<void> {
		const { route, report, target } = await this.routeContext(routeId);
		// Claim ownership before an SDK upload. A queued route starts an immutable
		// draft; a running route may only resume that exact draft after a safe
		// pre-task interruption. Completed/blocked routes are deliberate no-ops.
		if (route.routeType !== "skyvern_portal" || route.providerRegistryKey !== "gname" || !["queued", "running"].includes(route.status)) return;
		const definition = getProviderDefinition("gname");
		if (!definition) throw new Error("GNAME provider definition is missing.");
		if (!providerDefinitionMatchesPin(definition, route.providerDefinitionVersion, route.providerDefinitionHash)) {
			await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: ["queued", "running"], to: "needs_human", data: { reason: "provider_definition_pin_mismatch" } });
			return;
		}
		// Re-check the emergency kill switch immediately before any browser or
		// upload work. A queued job must honor a disable flag set after resolve.
		if (!isProviderRouteEnabled(definition)) {
			await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: ["queued", "running"], to: "no_route", data: { reason: "provider_route_disabled" } });
			return;
		}
		const identity = gnameServiceIdentity();
		if (!identity.verified) {
			await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: ["queued", "running"], to: "insufficient_evidence", data: { reason: "verified_service_identity_required" } });
			return;
		}
		const codeLockKey = gnameCodeLockKey(identity.mailbox);
		const codeLockOwner = gnameCodeLockOwner(route.id);
		const codeLockLeaseMs = envInt("ABUSE_GNAME_CODE_LOCK_MS", 75 * 60_000);
		const correlationKey = `portal-run:${route.id.toString()}`;
		const derivativeArtifacts = (await AbuseRepository.listArtifacts(report.id, ["provider_evidence_derivative"]))
			.filter((artifact) => artifact.routeId === route.id)
			.slice(0, definition.evidence.maximumImages);
		if (derivativeArtifacts.length === 0) {
			await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: ["queued", "running"], to: "insufficient_evidence", data: { reason: "provider_compatible_evidence_missing" } });
			return;
		}
		const taskInput = {
			entryUrl: definition.entryUrl,
			description: makeProviderDescription(report.description, target.normalizedTarget, target.observedUrls),
			domains: [target.normalizedTarget],
			observedUrls: target.observedUrls,
			serviceName: identity.name,
			legalBrandUrl: report.legalBrandUrl ?? "",
			serviceMailbox: identity.mailbox,
			webhookUrl: process.env.ABUSE_SKYVERN_WEBHOOK_URL,
			totpIdentifier: identity.mailbox,
		};
		const providerPayload = {
			adapter: "gname_category_2_v1",
			stage: "evidence_upload_pending",
			taskInput,
			contract: {
				entryUrl: definition.entryUrl,
				providerDefinitionVersion: definition.version,
				providerDefinitionHash: definition.contentHash,
				domains: [target.normalizedTarget],
				observedUrls: target.observedUrls,
				allowedFinalDomains: definition.verifiedDomains,
				declarationContract: "gname_service_declaration_v1",
			},
			 sourceArtifacts: derivativeArtifacts.map((artifact) => ({
				id: artifact.id.toString(),
				name: artifact.name,
				mimeType: artifact.mimeType,
				sha256: artifact.sha256,
				size: artifact.size,
			})),
			evidenceUploads: derivativeArtifacts.map((artifact) => ({
				artifactId: artifact.id.toString(),
				sha256: artifact.sha256,
				state: "pending",
			})),
		};
		const execution = await AbuseRepository.beginGnamePortalExecution({
			routeId: route.id,
			correlationKey,
			providerPayload: route.status === "queued" ? providerPayload : undefined,
			lockKey: codeLockKey,
			lockOwner: codeLockOwner,
			lockLeaseMs: codeLockLeaseMs,
		});
		if (!execution.acquired) {
			if (execution.reason === "route_not_eligible") return;
			throw new Error("The shared GNAME verification mailbox is currently reserved by another portal run.");
		}
		let retainCodeLock = false;
		const preparationLockKey = gnamePreparationLockKey(route.id);
		const preparationLockOwner = `${this.owner}:gname-preparation:${route.id.toString()}`;
		const preparationLockLeaseMs = envInt("ABUSE_GNAME_PREPARATION_LOCK_MS", 2 * 60_000);
		let holdsPreparationLock = false;
		const lockHeartbeat = setInterval(() => {
			void AbuseRepository.renewLock(codeLockKey, codeLockOwner, codeLockLeaseMs);
		}, Math.max(1_000, Math.floor(codeLockLeaseMs / 3)));
		let preparationHeartbeat: ReturnType<typeof setInterval> | undefined;
		try {
			// The route-owned mailbox lock intentionally has a deterministic owner so
			// it survives worker restarts. That means it cannot distinguish two stale
			// workers for the same route; this short-lived unique-owner lease does.
			if (!(await AbuseRepository.tryAcquireLock(preparationLockKey, preparationLockOwner, preparationLockLeaseMs))) {
				// Another worker owns the pre-task work. Never release the shared code
				// lock here: its deterministic route owner may belong to that worker.
				retainCodeLock = true;
				return;
			}
			holdsPreparationLock = true;
			preparationHeartbeat = setInterval(() => {
				void AbuseRepository.renewLock(preparationLockKey, preparationLockOwner, preparationLockLeaseMs);
			}, Math.max(1_000, Math.floor(preparationLockLeaseMs / 3)));

			const run = execution.run;
			if (run.skyvernRunId) {
				retainCodeLock = true;
				await AbuseRepository.enqueueJob({
					jobType: "reconcile_skyvern_run",
					reportId: report.id,
					routeId: route.id,
					runId: run.id,
					payload: { skyvernRunId: run.skyvernRunId },
					dedupeKey: `reconcile:${run.id.toString()}:${run.skyvernRunId}`,
				});
				return;
			}
			if (run.executionStatus === "task_creation_started") {
				const message = "Skyvern task creation was interrupted after its durable pre-call marker; task creation will not be retried automatically.";
				await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "task_creation_interrupted" });
				retainCodeLock = true;
				throw new UnknownExternalStateError(message);
			}
			if (run.executionStatus !== "starting") {
				const message = `GNAME portal run is not eligible for task preparation from ${run.executionStatus}.`;
				await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_portal_run_state_invalid" });
				retainCodeLock = true;
				throw new UnknownExternalStateError(message);
			}

			const persistedPayload = recordValue(run.providerPayload);
			if (!persistedPayload) {
				const message = "The persisted GNAME portal payload is malformed; automatic task creation is blocked.";
				await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_payload_invalid" });
				retainCodeLock = true;
				throw new UnknownExternalStateError(message);
			}
			const sources = storedGnameEvidenceSources(persistedPayload);
			const input = storedGnameTaskInput(persistedPayload);
			const uploads = sources ? storedGnameEvidenceUploads(persistedPayload, sources) : undefined;
			if (!sources || !input || !uploads || !["evidence_upload_pending", "task_payload_prepared"].includes(persistedPayload.stage as string)) {
				const message = "The persisted GNAME evidence-upload draft is malformed; automatic task creation is blocked.";
				await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_payload_draft_invalid" });
				retainCodeLock = true;
				throw new UnknownExternalStateError(message);
			}
			const artifactsById = new Map(derivativeArtifacts.map((artifact) => [artifact.id.toString(), artifact]));
			const sourceArtifacts = sources.map((source) => artifactsById.get(source.id));
			if (sourceArtifacts.some((artifact) => !artifact)) {
				const message = "A persisted GNAME evidence source is no longer available; automatic task creation is blocked.";
				await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_payload_source_missing" });
				retainCodeLock = true;
				throw new UnknownExternalStateError(message);
			}
			for (const [index, source] of sources.entries()) {
				const artifact = sourceArtifacts[index]!;
				if (artifact.name !== source.name || artifact.mimeType !== source.mimeType || artifact.sha256 !== source.sha256 || artifact.size !== source.size) {
					const message = "Persisted GNAME evidence source metadata no longer matches its immutable artifact.";
					await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_payload_source_metadata_changed" });
					retainCodeLock = true;
					throw new UnknownExternalStateError(message);
				}
			}

			const uncertainUpload = uploads.find((upload) => upload.state === "upload_started");
			if (uncertainUpload) {
				const message = `GNAME evidence upload for artifact ${uncertainUpload.artifactId} was interrupted after its durable pre-call marker; it will not be replayed automatically.`;
				await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_evidence_upload_interrupted" });
				retainCodeLock = true;
				throw new UnknownExternalStateError(message);
			}

			let taskPayload = persistedPayload.stage === "task_payload_prepared"
				? storedSkyvernTaskPayload(persistedPayload.task)
				: undefined;
			if (!taskPayload) {
				if (persistedPayload.stage !== "evidence_upload_pending") {
					const message = "The persisted GNAME task payload is malformed; automatic task creation is blocked.";
					await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_task_payload_invalid" });
					retainCodeLock = true;
					throw new UnknownExternalStateError(message);
				}
				let adapter: AbuseSkyvernAdapter | undefined;
				for (const [index, source] of sources.entries()) {
					const upload = uploads[index]!;
					const artifact = sourceArtifacts[index]!;
					if (upload.state === "uploaded") continue;
					try {
						adapter ??= this.getAdapter();
					} catch (error) {
						const message = errorText(error);
						if (await AbuseRepository.requeueGnamePortalPreparation({ runId: run.id, error: message })) {
							throw new Error(`GNAME evidence upload setup failed before an SDK call: ${message}`);
						}
						const unknown = `GNAME evidence-upload setup could not be safely reconciled: ${message}`;
						await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: unknown, reason: "gname_upload_setup_conflict" });
						retainCodeLock = true;
						throw new UnknownExternalStateError(unknown);
					}
					const preparation = await AbuseRepository.beginGnameEvidenceUpload({ runId: run.id, artifactId: source.id, sha256: source.sha256 });
					if (preparation !== "started") {
						const message = preparation === "already_started"
							? `GNAME evidence upload for artifact ${source.id} entered an ambiguous external state.`
							: `GNAME evidence upload for artifact ${source.id} could not acquire its durable pre-call marker.`;
						await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: preparation === "already_started" ? "gname_evidence_upload_interrupted" : "gname_evidence_upload_marker_conflict" });
						retainCodeLock = true;
						throw new UnknownExternalStateError(message);
					}
					let uploadedFile: { presignedUrl: string; sha256: string };
					try {
						uploadedFile = await adapter.uploadFile({ buffer: artifact.blob, filename: artifact.name, mimeType: artifact.mimeType });
					} catch (error) {
						const message = `GNAME evidence upload may have crossed the Skyvern boundary: ${errorText(error)}`;
						await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_evidence_upload_ambiguous" });
						retainCodeLock = true;
						throw new UnknownExternalStateError(message);
					}
					if (uploadedFile.sha256 !== source.sha256) {
						const message = "Skyvern returned evidence-upload metadata that did not match the immutable source artifact.";
						await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_evidence_upload_hash_mismatch" });
						retainCodeLock = true;
						throw new UnknownExternalStateError(message);
					}
					const expiresAt = gnameEvidenceUploadDeadline(uploadedFile.presignedUrl, new Date());
					if (!(await AbuseRepository.recordGnameEvidenceUpload({
						runId: run.id,
						artifactId: source.id,
						sha256: source.sha256,
						presignedUrl: uploadedFile.presignedUrl,
						expiresAt,
					}))) {
						const message = "Skyvern evidence upload completed after its local checkpoint could no longer be recorded.";
						await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_evidence_upload_checkpoint_conflict" });
						retainCodeLock = true;
						throw new UnknownExternalStateError(message);
					}
					uploads[index] = {
						artifactId: source.id,
						sha256: source.sha256,
						state: "uploaded",
						presignedUrl: uploadedFile.presignedUrl,
						uploadedAt: new Date().toISOString(),
						expiresAt: expiresAt.toISOString(),
					};
				}
			}

			const minimumRemainingMs = envInt("ABUSE_GNAME_UPLOAD_URL_MIN_REMAINING_MS", 60_000);
			if (uploads.some((upload) => upload.state !== "uploaded" || !upload.presignedUrl || !upload.expiresAt || Date.parse(upload.expiresAt) - Date.now() <= minimumRemainingMs)) {
				const message = "A persisted GNAME evidence-upload URL is missing or too close to expiry; automatic task creation will not re-upload evidence.";
				await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_evidence_upload_url_expired" });
				retainCodeLock = true;
				throw new UnknownExternalStateError(message);
			}
			const expectedTaskPayload = buildGnameTaskPayload({
				...input,
				presignedEvidenceUrls: uploads.map((upload) => upload.presignedUrl!),
			});
			if (taskPayload && stableJson(taskPayload) !== stableJson(expectedTaskPayload)) {
				const message = "The persisted GNAME task payload no longer matches its immutable evidence-upload contract.";
				await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_task_payload_contract_mismatch" });
				retainCodeLock = true;
				throw new UnknownExternalStateError(message);
			}
			taskPayload ??= expectedTaskPayload;
			if (persistedPayload.stage === "evidence_upload_pending") {
				const completedPayload = {
					...persistedPayload,
					stage: "task_payload_prepared",
					evidenceUploads: uploads,
					task: taskPayload,
					uploadedEvidence: uploads.map((upload) => ({ url: upload.presignedUrl, sha256: upload.sha256, artifactId: upload.artifactId })),
				};
				if (!(await AbuseRepository.prepareGnamePortalTaskPayload({ runId: run.id, providerPayload: completedPayload }))) {
					const latest = await AbuseRepository.getProviderRun(run.id);
					if (latest?.skyvernRunId) {
						retainCodeLock = true;
						await AbuseRepository.enqueueJob({
							jobType: "reconcile_skyvern_run",
							reportId: report.id,
							routeId: route.id,
							runId: latest.id,
							payload: { skyvernRunId: latest.skyvernRunId },
							dedupeKey: `reconcile:${latest.id.toString()}:${latest.skyvernRunId}`,
						});
						return;
					}
					const message = "The GNAME task payload changed while evidence uploads were being finalized; automatic task creation is blocked.";
					await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_payload_preparation_conflict" });
					retainCodeLock = true;
					throw new UnknownExternalStateError(message);
				}
			}

			if (!taskPayload) throw new Error("GNAME task payload was not prepared.");
			// Constructing the SDK adapter is local configuration work. Do it before
			// the durable pre-call marker so a missing key/base URL remains a normal
			// retryable setup failure rather than an apparent external ambiguity.
			const adapter = this.getAdapter();
			if (!(await AbuseRepository.prepareSkyvernTaskCreation(run.id))) {
				const latest = await AbuseRepository.getProviderRun(run.id);
				if (latest?.skyvernRunId) {
					retainCodeLock = true;
					await AbuseRepository.enqueueJob({
						jobType: "reconcile_skyvern_run",
						reportId: report.id,
						routeId: route.id,
						runId: latest.id,
						payload: { skyvernRunId: latest.skyvernRunId },
						dedupeKey: `reconcile:${latest.id.toString()}:${latest.skyvernRunId}`,
					});
					return;
				}
				const message = "Skyvern task creation could not acquire its durable pre-call marker.";
				await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "task_creation_marker_conflict" });
				retainCodeLock = true;
				throw new UnknownExternalStateError(message);
			}

			let created: { runId: string };
			try {
				created = await adapter.createTask(taskPayload);
			} catch (error) {
				const message = errorText(error);
				await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "task_creation_ambiguous" });
				retainCodeLock = true;
				throw new UnknownExternalStateError(`Skyvern task creation was ambiguous: ${message}`);
			}
			if (!(await AbuseRepository.recordSkyvernTaskStarted({ runId: run.id, skyvernRunId: created.runId, routeStatus: "waiting_code" }))) {
				const message = "Skyvern task creation completed after the route left its expected state; operational reconciliation is required.";
				await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "task_creation_state_changed" });
				retainCodeLock = true;
				throw new UnknownExternalStateError(message);
			}
			retainCodeLock = true;
		} finally {
			clearInterval(lockHeartbeat);
			if (preparationHeartbeat) clearInterval(preparationHeartbeat);
			if (holdsPreparationLock) await AbuseRepository.releaseLock(preparationLockKey, preparationLockOwner);
			if (!retainCodeLock && holdsPreparationLock) await AbuseRepository.releaseLock(codeLockKey, codeLockOwner);
		}
	}

	private async runGenericProviderPortal(routeId: bigint, payload: Record<string, unknown>): Promise<void> {
		const { route, report, target } = await this.routeContext(routeId);
		// A public link can start this adapter only from the explicit
		// not-monitored escalation transition. A `running` route is a replay of
		// the exact immutable payload already persisted by that transition.
		if (!['escalating_to_portal', 'running'].includes(route.status)) return;
		if (route.routeType !== "email" || !route.verifiedEmail) throw new Error("Generic portal escalation requires a verified email route.");
		if (route.status === "escalating_to_portal" && !isGenericFormEscalationEnabled()) {
			await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "escalating_to_portal", to: "provider_rejected", data: { reason: "generic_form_escalation_disabled" } });
			return;
		}
		let correlationKey: string;
		let providerPayload: Record<string, unknown>;
		let taskPayload: SkyvernTaskPayload | undefined;
		if (route.status === "escalating_to_portal") {
			const providerLink = typeof payload.providerLink === "string" ? payload.providerLink : undefined;
			if (!providerLink) {
				await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "escalating_to_portal", to: "provider_rejected", data: { reason: "generic_provider_link_missing" } });
				return;
			}
			const verifiedDomains = verifiedDomainsForEmailRoute(route.verifiedEmail);
			const resolvedEntryUrl = await resolveVerifiedProviderLink({ candidate: providerLink, verifiedDomains });
			if (!resolvedEntryUrl) {
				await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "escalating_to_portal", to: "provider_rejected", data: { reason: "generic_provider_link_origin_changed" } });
				return;
			}
			const entryUrl = new URL(resolvedEntryUrl);
			taskPayload = buildGenericProviderFormTaskPayload({
				entryUrl: entryUrl.toString(),
				allowedDomains: verifiedDomains,
				target: target.normalizedTarget,
				allegationCategory: report.allegationCategory,
				description: report.description,
				observedUrls: target.observedUrls,
				legalBrandUrl: report.legalBrandUrl ?? undefined,
				reporterContactEmail: report.reporterContactEmail ?? undefined,
				webhookUrl: process.env.ABUSE_SKYVERN_WEBHOOK_URL,
			});
			correlationKey = `generic-portal:${route.id.toString()}:${crypto.createHash("sha256").update(entryUrl.toString()).digest("hex").slice(0, 24)}`;
			providerPayload = {
				adapter: "generic_verified_provider_form",
				entryUrl: entryUrl.toString(),
				verifiedDomains,
				task: taskPayload,
				contract: {
					entryUrl: entryUrl.toString(),
					target: target.normalizedTarget,
					observedUrls: target.observedUrls,
					allowedFinalDomains: verifiedDomains,
				},
			};
		} else {
			const priorRun = await AbuseRepository.getLatestProviderRunForRoute(route.id);
			const priorPayload = priorRun && recordValue(priorRun.providerPayload);
			if (!priorRun || !priorPayload || priorPayload.adapter !== "generic_verified_provider_form") {
				const message = "A running generic provider-form route has no valid durable task payload.";
				await this.markUnknownExternal({ routeId: route.id, error: message, reason: "generic_portal_run_missing" });
				throw new UnknownExternalStateError(message);
			}
			correlationKey = priorRun.correlationKey;
			providerPayload = priorPayload;
			taskPayload = storedSkyvernTaskPayload(priorPayload.task);
			if (!taskPayload) {
				const message = "The persisted generic provider-form task payload is malformed.";
				await this.markUnknownExternal({ routeId: route.id, runId: priorRun.id, error: message, reason: "generic_portal_payload_invalid" });
				throw new UnknownExternalStateError(message);
			}
		}
		const taskCreationLockKey = portalTaskCreationLockKey(route.id);
		const taskCreationLockOwner = `${this.owner}:portal-task-creation:${route.id.toString()}`;
		const taskCreationLockLeaseMs = envInt("ABUSE_PORTAL_TASK_CREATION_LOCK_MS", 5 * 60_000);
		if (!(await AbuseRepository.tryAcquireLock(taskCreationLockKey, taskCreationLockOwner, taskCreationLockLeaseMs))) {
			// A live worker owns this route's durable pre-call boundary. Its job
			// will either persist the Skyvern ID or leave the pre-call marker for a
			// later recovery. Never turn that live ownership into a false ambiguity.
			return;
		}
		const lockHeartbeat = setInterval(() => {
			void AbuseRepository.renewLock(taskCreationLockKey, taskCreationLockOwner, taskCreationLockLeaseMs);
		}, Math.max(1_000, Math.floor(taskCreationLockLeaseMs / 3)));
		try {
			// Adapter construction is local configuration validation. Do it before
			// creating a run marker so missing credentials or a booting sidecar are
			// ordinary retryable failures, not external-state ambiguities.
			const adapter = this.getAdapter();
			const execution = await AbuseRepository.beginPortalExecution({
				routeId: route.id,
				correlationKey,
				providerPayload,
				expectedStatus: "escalating_to_portal",
			});
			if (!execution) return;
			const run = execution.run;
			if (run.skyvernRunId) {
				await AbuseRepository.enqueueJob({
					jobType: "reconcile_skyvern_run",
					reportId: report.id,
					routeId: route.id,
					runId: run.id,
					payload: { skyvernRunId: run.skyvernRunId },
					dedupeKey: `reconcile:${run.id.toString()}:${run.skyvernRunId}`,
				});
				return;
			}
			if (run.executionStatus === "task_creation_started") {
				const message = "Generic provider-form task creation was interrupted after its durable pre-call marker; it will not be retried automatically.";
				await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "task_creation_interrupted" });
				throw new UnknownExternalStateError(message);
			}
			if (run.executionStatus !== "starting") {
				const message = `Generic provider-form run is not eligible for task creation from ${run.executionStatus}.`;
				await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "generic_portal_run_state_invalid" });
				throw new UnknownExternalStateError(message);
			}
			const durableTaskPayload = storedSkyvernTaskPayload(recordValue(run.providerPayload)?.task);
			if (!durableTaskPayload) {
				const message = "The generic provider-form task payload could not be recovered from durable storage.";
				await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "generic_portal_payload_missing" });
				throw new UnknownExternalStateError(message);
			}
			if (!(await AbuseRepository.prepareSkyvernTaskCreation(run.id))) {
				const latest = await AbuseRepository.getProviderRun(run.id);
				if (latest?.skyvernRunId) {
					await AbuseRepository.enqueueJob({
						jobType: "reconcile_skyvern_run",
						reportId: report.id,
						routeId: route.id,
						runId: latest.id,
						payload: { skyvernRunId: latest.skyvernRunId },
						dedupeKey: `reconcile:${latest.id.toString()}:${latest.skyvernRunId}`,
					});
					return;
				}
				const message = "Generic provider-form task creation could not acquire its durable pre-call marker.";
				await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "task_creation_marker_conflict" });
				throw new UnknownExternalStateError(message);
			}
			let created: { runId: string };
			try {
				created = await adapter.createTask(durableTaskPayload);
			} catch (error) {
				const message = errorText(error);
				await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "task_creation_ambiguous" });
				throw new UnknownExternalStateError(`Generic provider form task creation was ambiguous: ${message}`);
			}
			if (!(await AbuseRepository.recordSkyvernTaskStarted({ runId: run.id, skyvernRunId: created.runId, routeStatus: "running" }))) {
				const message = "Skyvern task creation completed after the route left its expected state; operational reconciliation is required.";
				await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "task_creation_state_changed" });
				throw new UnknownExternalStateError(message);
			}
		} finally {
			clearInterval(lockHeartbeat);
			await AbuseRepository.releaseLock(taskCreationLockKey, taskCreationLockOwner);
		}
	}

	private async reconcileSkyvern(runId: bigint): Promise<void> {
		const run = await AbuseRepository.getProviderRun(runId);
		if (!run || !run.skyvernRunId) return;
		const route = await AbuseRepository.getRoute(run.routeId);
		if (!route) return;
		// Replayed webhooks and stale poll jobs must not re-read a terminal run
		// and turn a previously successful route into a failure because output or
		// artifacts are no longer returned by Skyvern.
		if (["submitted", "acknowledged", "provider_rejected", "delivery_failed", "insufficient_evidence", "no_route", "failed", "needs_human", "unknown_external_state"].includes(route.status)) return;
		const isGname = route.providerRegistryKey === "gname";
		const identity = isGname ? gnameServiceIdentity() : undefined;
		const lockKey = identity?.mailbox ? gnameCodeLockKey(identity.mailbox) : undefined;
		const lockOwner = isGname ? gnameCodeLockOwner(route.id) : undefined;
		const lockLeaseMs = envInt("ABUSE_GNAME_CODE_LOCK_MS", 75 * 60_000);
		let lockHeartbeat: ReturnType<typeof setInterval> | undefined;
		if (lockKey && lockOwner) {
			// Reconciliation must renew the lock we already acquired during task
			// creation. Re-acquiring an expired lock would be unsafe: another route
			// could have consumed the shared mailbox's next code in the meantime.
			if (!(await AbuseRepository.renewLock(lockKey, lockOwner, lockLeaseMs))) {
				const message = "The shared GNAME mailbox lock was lost while the external run was active; automatic reconciliation is blocked.";
				await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_mailbox_lock_lost" });
				throw new UnknownExternalStateError(message);
			}
			lockHeartbeat = setInterval(() => {
				void AbuseRepository.renewLock(lockKey, lockOwner, lockLeaseMs);
			}, Math.max(1_000, Math.floor(lockLeaseMs / 3)));
		}
		try {
			// Missing local configuration or a bootstrap sidecar that is still
			// writing its key means no external request occurred. Let the durable
			// job retry normally; only SDK calls below can cross the ambiguity line.
			const adapter = this.getAdapter();
			const result = await adapter.reconcileRun({
				runId: run.skyvernRunId,
				reportId: run.reportId,
				routeId: run.routeId,
				providerKey: route.providerRegistryKey,
				localRunId: run.id,
			});
			if (!isTerminalSkyvernStatus(result.status)) {
				await AbuseRepository.enqueueJob({
					jobType: "reconcile_skyvern_run",
					reportId: run.reportId,
					routeId: run.routeId,
					runId: run.id,
					payload: { skyvernRunId: run.skyvernRunId },
					// The current job is still running until processJob returns. Give
					// each future poll a unique durable key instead of self-deduping.
					dedupeKey: `reconcile:${run.id.toString()}:${run.skyvernRunId}:${Date.now()}`,
					nextAttemptAt: new Date(Date.now() + 15_000),
				});
				return;
			}
			const output = result.output ?? {};
			await AbuseRepository.saveArtifact({
				reportId: run.reportId,
				routeId: run.routeId,
				runId: run.id,
				name: `skyvern-output-${run.skyvernRunId}.json`,
				kind: "skyvern_extracted_output",
				mimeType: "application/json",
				buffer: Buffer.from(stableJson(output), "utf8"),
				metadata: { providerKey: route.providerRegistryKey, skyvernRunId: run.skyvernRunId, status: result.status ?? "unknown" },
			});
			const contract = validateSkyvernOutputContract({
				output,
				providerKey: route.providerRegistryKey,
				providerPayload: run.providerPayload,
			});
			const completed = result.status === "completed";
			const routeStatus = completed && contract.passed && !result.failureReason
				? "submitted"
				: completed
					? "needs_human"
					: "failed";
			const settled = await AbuseRepository.settleSkyvernRun({
				runId: run.id,
				executionStatus: completed ? "completed" : result.status === "canceled" ? "canceled" : "failed",
				routeStatus,
				confirmationId: completed && contract.passed ? contract.confirmationId : undefined,
				confirmationText: completed && contract.passed ? contract.confirmationText : undefined,
				finalUrl: completed && contract.passed ? contract.finalUrl : undefined,
				submittedTargets: completed && contract.passed ? contract.submittedTargets : [],
				failureReason: result.failureReason ?? (contract.passed ? undefined : contract.reason),
				routeData: { reason: output.form_drift === true ? contract.reason ?? "provider_form_drift" : contract.reason },
			});
			if (!settled) return;
		} finally {
			if (lockHeartbeat) clearInterval(lockHeartbeat);
			if (lockKey && lockOwner) {
				const finalRun = await AbuseRepository.getProviderRun(run.id);
				const terminal = finalRun && ["completed", "failed", "canceled"].includes(finalRun.executionStatus);
				if (terminal) await AbuseRepository.releaseLock(lockKey, lockOwner);
			}
		}
	}

	private async sendTotpCode(job: AbuseJob): Promise<void> {
		const routeId = idFrom(job.routeId, "routeId");
		const route = await AbuseRepository.getRoute(routeId);
		if (!route || route.providerRegistryKey !== "gname" || route.status !== "waiting_code") return;
		const messageId = parseJobBigInt(job.payload?.messageId, "payload.messageId");
		const mail = await AbuseRepository.getMailMessage(messageId);
		if (!mail || mail.routeId !== route.id) throw new Error("Verification-code message is not associated with the provider route.");
		const code = extractVerificationCode(mail.textBody ?? "");
		if (!code) throw new Error("No unambiguous verification code was found in the provider message.");
		const runId = job.runId ?? parseOptionalBigInt(job.payload?.runId);
		const run = runId ? await AbuseRepository.getProviderRun(runId) : await AbuseRepository.getLatestActiveProviderRunForRoute(route.id);
		if (!run?.skyvernRunId) {
			const message = "No active Skyvern run could be safely correlated with the GNAME verification code.";
			await this.markUnknownExternal({ routeId: route.id, runId: run?.id, error: message, reason: "totp_without_active_run" });
			throw new UnknownExternalStateError(message);
		}
		if (run.executionStatus === "sending_code") {
			const message = "GNAME verification-code delivery was interrupted after its durable pre-delivery marker; automatic replay is unsafe.";
			await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "totp_delivery_interrupted" });
			throw new UnknownExternalStateError(message);
		}
		// Resolve local configuration only after the run is correlated. A missing
		// key/base URL is a retryable local failure and did not contact Skyvern.
		const adapter = this.getAdapter();
		const identifier = typeof job.payload?.totpIdentifier === "string" && job.payload.totpIdentifier.trim()
			? job.payload.totpIdentifier.trim()
			: gnameServiceIdentity().mailbox;
		if (!identifier) throw new Error("GNAME TOTP identifier is not configured.");
		const lockKey = gnameCodeLockKey(identifier);
		const lockOwner = gnameCodeLockOwner(route.id);
		if (!(await AbuseRepository.acquireOrRenewGnameMailboxLock({
			routeId: route.id,
			lockKey,
			owner: lockOwner,
			leaseMs: envInt("ABUSE_GNAME_CODE_LOCK_MS", 75 * 60_000),
		})).acquired) {
			throw new Error("The shared GNAME verification mailbox is no longer reserved for this route.");
		}
		// Persist the correlation before the side-effectful SDK call. If its
		// response is lost, the code is permanently tied to this exact task and
		// will never be replayed by an automatic retry.
		const preparation = await AbuseRepository.prepareTotpDelivery({
			routeId: route.id,
			runId: run.id,
			mailMessageId: mail.id,
			code,
			correlationKey: run.correlationKey,
		});
		if (preparation.state === "already_started") {
			const message = "GNAME verification-code delivery already entered an ambiguous external state.";
			await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "totp_delivery_interrupted" });
			throw new UnknownExternalStateError(message);
		}
		try {
			await adapter.sendTotpCode({ identifier, content: code, taskId: run.skyvernRunId });
			if (!(await AbuseRepository.settleTotpDelivery({ routeId: route.id, runId: run.id, mailCodeId: preparation.mailCodeId }))) {
				const message = "Verification code delivery completed after the route left its expected state; operational reconciliation is required.";
				await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "totp_delivery_state_changed" });
				throw new UnknownExternalStateError(message);
			}
		} catch (error) {
			// Preserve the shared-mailbox lease after an ambiguous SDK delivery. It
			// remains owned until explicit operational resolution. Repeating an OTP
			// request could race the same portal task or consume a later code.
			const message = `Skyvern verification-code delivery was ambiguous: ${errorText(error)}`;
			await this.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "totp_delivery_ambiguous" });
			throw new UnknownExternalStateError(message);
		}
	}

	private async classifyReply(messageId: bigint): Promise<void> {
		const message = await AbuseRepository.getMailMessage(messageId);
		if (!message) return;
		const result = await classifyProviderReply({ text: message.textBody ?? "", from: message.fromAddress ?? undefined });
		const route = await AbuseRepository.getRoute(message.routeId);
		if (!route) return;
		const links = result.classification === "not_monitored"
			? await extractVerifiedProviderLinks({
				providerKey: route.providerRegistryKey === "gname" ? route.providerRegistryKey : undefined,
				verifiedDomains: route.verifiedEmail ? verifiedDomainsForEmailRoute(route.verifiedEmail) : undefined,
				text: message.textBody ?? "",
			})
			: [];
		await AbuseRepository.setMailClassification(message.id, result.classification, links, result.rationale);
		if (result.classification === "acknowledged") {
			await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "awaiting_provider_reply", to: "acknowledged" });
		} else if (result.classification === "not_monitored" && links.length > 0 && isGenericFormEscalationEnabled()) {
			// A link only reaches this point after exact provider-origin and every
			// redirect hop was revalidated. The generic task still gets only a
			// code-owned prompt and immutable stored payload.
			if (await AbuseRepository.transitionRouteStatus({
				routeId: route.id,
				from: "awaiting_provider_reply",
				to: "escalating_to_portal",
				data: { providerLink: links[0] },
			})) {
				await AbuseRepository.enqueueJob({
					jobType: "run_portal",
					reportId: route.reportId,
					routeId: route.id,
					payload: { providerLink: links[0], sourceMailMessageId: message.id.toString() },
					dedupeKey: `generic-portal:${route.id.toString()}`,
				});
			}
		} else if (result.classification === "not_monitored") {
			await AbuseRepository.transitionRouteStatus({
				routeId: route.id,
				from: "awaiting_provider_reply",
				to: "provider_rejected",
				data: { reason: links.length ? "generic_form_escalation_disabled" : "provider_mailbox_not_monitored_without_verified_form" },
			});
		} else if (result.classification === "needs_more_information") {
			// No immutable route policy can currently determine which provider
			// questions are safely answerable from stored evidence. Finish safely
			// rather than making email text an instruction source.
			await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "awaiting_provider_reply", to: "provider_rejected", data: { reason: "provider_requested_information_without_route_policy" } });
		} else if (result.classification === "rejected") {
			await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "awaiting_provider_reply", to: "provider_rejected" });
		}
		else if (result.classification === "bounce") {
			// A bounce may arrive immediately after SMTP acceptance, before the
			// sender moves the run/route into its normal waiting state. Correlate and
			// settle all three records atomically so a late sender completion cannot
			// restore `awaiting_provider_reply` over the known delivery failure.
			const bounced = await AbuseRepository.settleCorrelatedEmailBounce({ inboundMessageId: message.id });
			if (!bounced.settled) {
				await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "awaiting_provider_reply", to: "provider_rejected", data: { reason: "uncorrelated_provider_bounce" } });
			}
		}
	}

	private async monitorProviderReply(routeId: bigint): Promise<void> {
		const route = await AbuseRepository.getRoute(routeId);
		if (!route || route.status !== "awaiting_provider_reply") return;
		// IMAP continuously creates concrete reply-classification jobs. Silence
		// is not a reason to escalate to a portal or change the route state.
		await AbuseRepository.recomputeReportStatus(route.reportId);
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
