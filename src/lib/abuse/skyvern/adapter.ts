import { SkyvernClient } from "@skyvern/client";
import { isIP } from "node:net";

import { AbuseRepository } from "../repository";
import { assertPublicDnsHost, isPublicIp, normalizeDomain, sha256Hex } from "../security";
import { configuredSkyvernApiKey, configuredSkyvernBaseUrl } from "../skyvern_config";
import {
	asString,
	NO_RETRY,
	objectPayload,
	objectPayloadOrUndefined,
	runIdOf,
	statusOf,
	type SdkRunSdkActionRequest,
	type SdkRunTaskRequest,
	type SdkTotpCodeRequest,
	type SdkUploadFileRequest,
	type SkyvernArtifactFetcher,
	type SkyvernClientPort,
	type SkyvernRunStatus,
	type SkyvernTaskPayload,
	unwrapSdkResponse,
} from "./contracts";
import { ensureSkyvernStorageUrl, fetchSkyvernArtifact, safeArtifactUrl, urlHostname } from "./storage";

function createConfiguredClient(): SkyvernClientPort {
	const baseUrl = configuredSkyvernBaseUrl();
	const apiKey = configuredSkyvernApiKey();
	return new SkyvernClient({ baseUrl, apiKey, maxRetries: 0 }) as unknown as SkyvernClientPort;
}

function redactExternalError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/(?:api[_-]?key|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]").slice(0, 2_000);
}

export class AbuseSkyvernAdapter {
	private readonly client: SkyvernClientPort;
	private readonly artifactFetcher: SkyvernArtifactFetcher;
	private readonly assertHost: (hostname: string) => Promise<void>;

	constructor(params?: {
		client?: SkyvernClientPort;
		artifactFetcher?: SkyvernArtifactFetcher;
		/** Injected only for deterministic safety tests; production uses DNS validation. */
		assertHost?: (hostname: string) => Promise<void>;
	}) {
		this.client = params?.client ?? createConfiguredClient();
		this.artifactFetcher = params?.artifactFetcher ?? fetchSkyvernArtifact;
		this.assertHost = params?.assertHost ?? assertPublicDnsHost;
	}

	/** Upload through the SDK and expose only the returned presigned URL to task construction. */
	async uploadFile(params: { buffer: Buffer; filename: string; mimeType: string }): Promise<{ presignedUrl: string; sha256: string }> {
		const request = {
			file: {
				data: params.buffer,
				filename: params.filename,
				contentType: params.mimeType,
				contentLength: params.buffer.byteLength,
			},
		} satisfies SdkUploadFileRequest;
		const response = objectPayload(await this.client.uploadFile(request, NO_RETRY), "file upload");
		return { presignedUrl: ensureSkyvernStorageUrl(response.presigned_url, "presigned upload"), sha256: sha256Hex(params.buffer) };
	}

	/**
	 * The only task-creation entry point. The payload is already immutable and
	 * provider-owned when it reaches this method; no public request can add
	 * prompts, selectors, URLs, headers, proxies, or browser addresses.
	 */
	async createTask(payload: SkyvernTaskPayload): Promise<{ runId: string; response: Record<string, unknown> }> {
		const request = { body: payload } satisfies SdkRunTaskRequest;
		const response = objectPayload(await this.client.runTask(request, NO_RETRY), "task creation");
		const runId = runIdOf(response);
		if (!runId) throw new Error("Skyvern task creation returned no run ID.");
		return { runId, response };
	}

	async getRun(runId: string): Promise<Record<string, unknown>> {
		return objectPayload(await this.client.getRun(runId), "run");
	}

	async cancelRun(runId: string): Promise<void> {
		await this.client.cancelRun(runId, NO_RETRY);
	}

	async retryWebhook(runId: string): Promise<void> {
		await this.client.retryRunWebhook(runId, undefined, NO_RETRY);
	}

	async sendTotpCode(params: { identifier: string; content: string; taskId?: string; runId?: string }): Promise<void> {
		const request = {
			totp_identifier: params.identifier,
			content: params.content,
			...(params.taskId ? { task_id: params.taskId } : {}),
			...(params.runId ? { workflow_run_id: params.runId } : {}),
			source: "email",
		} satisfies SdkTotpCodeRequest;
		await this.client.sendTotpCode(request, NO_RETRY);
	}

	/** Compatibility probe for the SDK's deterministic ai_upload_file action. */
	async runSdkUpload(params: { url: string; presignedUrl: string; intention: string; browserSessionId?: string }): Promise<Record<string, unknown>> {
		let parsed: URL;
		try {
			parsed = new URL(params.url);
		} catch {
			throw new Error("SDK upload target must be a valid public HTTPS URL.");
		}
		const hostname = urlHostname(parsed);
		if (
			parsed.protocol !== "https:"
			|| parsed.username
			|| parsed.password
			|| parsed.port
			|| parsed.hash
			|| !(isIP(hostname) ? isPublicIp(hostname) : normalizeDomain(hostname))
		) {
			throw new Error("SDK upload target must be a valid public HTTPS URL.");
		}
		if (!isIP(hostname)) parsed.hostname = normalizeDomain(hostname)!;
		// Validate the only browser-side file source before any network lookup for
		// the target form. A malformed storage URL must never cause an otherwise
		// valid provider host to be resolved as part of an unusable SDK action.
		const presignedUrl = ensureSkyvernStorageUrl(params.presignedUrl, "presigned upload");
		await this.assertHost(hostname);
		const request = {
			url: parsed.toString(),
			...(params.browserSessionId ? { browser_session_id: params.browserSessionId } : {}),
			action: {
				type: "ai_upload_file",
				file_url: presignedUrl,
				intention: params.intention,
			},
		} satisfies SdkRunSdkActionRequest;
		return objectPayload(await this.client.runSdkAction(request, NO_RETRY), "SDK action");
	}

	async collectArtifacts(params: { runId: string; reportId: bigint; routeId: bigint; providerKey: string; localRunId?: bigint }): Promise<number> {
		const artifactsValue = unwrapSdkResponse<unknown>(await this.client.getRunArtifacts(params.runId));
		if (!Array.isArray(artifactsValue)) throw new Error("Skyvern returned an invalid artifact list.");
		const artifacts = artifactsValue as Array<Record<string, unknown>>;
		let imported = 0;
		for (const descriptor of artifacts) {
			const artifactId = asString(descriptor.artifact_id) ?? asString(descriptor.id);
			if (!artifactId || !/^[A-Za-z0-9._:-]{1,256}$/.test(artifactId)) continue;
			try {
				// getRunArtifacts can contain abbreviated descriptors. Always retrieve
				// the canonical SDK artifact record before importing permanent bytes.
				const detailed = objectPayload(await this.client.getArtifact(artifactId), "artifact");
				const url = safeArtifactUrl(asString(detailed.signed_url) ?? asString(detailed.uri) ?? asString(descriptor.signed_url) ?? asString(descriptor.uri));
				const fetched = await this.artifactFetcher(url.toString());
				await AbuseRepository.saveArtifact({
					reportId: params.reportId,
					routeId: params.routeId,
					runId: params.localRunId,
					name: `skyvern-${artifactId}`,
					kind: `skyvern_${asString(detailed.artifact_type) ?? asString(descriptor.artifact_type) ?? "artifact"}`,
					mimeType: fetched.mimeType ?? "application/octet-stream",
					buffer: fetched.body,
					metadata: { providerKey: params.providerKey, skyvernArtifactId: artifactId, sourceOrigin: url.origin },
				});
				imported += 1;
			} catch (error) {
				await AbuseRepository.saveArtifact({
					reportId: params.reportId,
					routeId: params.routeId,
					name: `skyvern-${artifactId}-metadata.json`,
					kind: "skyvern_artifact_import_error",
					mimeType: "application/json",
					buffer: Buffer.from(JSON.stringify({ descriptor, error: redactExternalError(error) })),
				});
			}
		}
		return imported;
	}

	async reconcileRun(params: { runId: string; reportId: bigint; routeId: bigint; providerKey: string; localRunId?: bigint }): Promise<{ status?: SkyvernRunStatus; output?: Record<string, unknown>; failureReason?: string }> {
		let run = objectPayload(await this.client.getRun(params.runId), "run");
		if (statusOf(run) === "failed" && /webhook(?:\s+delivery)?\s+(?:failed|error)|failed\s+to\s+deliver\s+webhook/i.test(asString(run.failure_reason) ?? "")) {
			// A webhook transport failure does not prove the provider task failed.
			// Re-read the authoritative run after asking Skyvern to redeliver.
			try {
				await this.retryWebhook(params.runId);
				run = objectPayload(await this.client.getRun(params.runId), "run");
			} catch {
				// The second getRun below still supplies the best authoritative state.
			}
		}
		const status = statusOf(run);
		if (status === "completed" || status === "failed" || status === "terminated" || status === "timed_out" || status === "canceled") {
			await this.collectArtifacts(params);
		}
		return {
			status,
			output: objectPayloadOrUndefined(run.output),
			failureReason: asString(run.failure_reason),
		};
	}
}
