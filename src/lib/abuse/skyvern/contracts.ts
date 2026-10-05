import { SkyvernClient } from "@skyvern/client";

type SdkRunTaskRequest = Parameters<SkyvernClient["runTask"]>[0];
type SdkUploadFileRequest = Parameters<SkyvernClient["uploadFile"]>[0];
type SdkTotpCodeRequest = Parameters<SkyvernClient["sendTotpCode"]>[0];
type SdkRunSdkActionRequest = Parameters<SkyvernClient["runSdkAction"]>[0];

/**
 * Narrow port used by the adapter and its deterministic test doubles. The
 * request positions deliberately derive from the pinned SDK so a generated
 * client contract change fails type-checking at this boundary instead of
 * silently reaching a side-effectful provider call at runtime.
 */
export type SkyvernClientPort = {
	runTask: (request: SdkRunTaskRequest, options?: Parameters<SkyvernClient["runTask"]>[1]) => Promise<unknown>;
	getRun: (runId: string) => Promise<unknown>;
	cancelRun: (runId: string, options?: Parameters<SkyvernClient["cancelRun"]>[1]) => Promise<unknown>;
	getRunArtifacts: (runId: string) => Promise<unknown>;
	getArtifact: (artifactId: string) => Promise<unknown>;
	retryRunWebhook: (runId: string, request?: Parameters<SkyvernClient["retryRunWebhook"]>[1], options?: Parameters<SkyvernClient["retryRunWebhook"]>[2]) => Promise<unknown>;
	sendTotpCode: (request: SdkTotpCodeRequest, options?: Parameters<SkyvernClient["sendTotpCode"]>[1]) => Promise<unknown>;
	uploadFile: (request: SdkUploadFileRequest, options?: Parameters<SkyvernClient["uploadFile"]>[1]) => Promise<unknown>;
	runSdkAction: (request: SdkRunSdkActionRequest, options?: Parameters<SkyvernClient["runSdkAction"]>[1]) => Promise<unknown>;
};

export type SkyvernRunStatus = "created" | "queued" | "running" | "completed" | "failed" | "terminated" | "timed_out" | "canceled";

export type SkyvernTaskPayload = {
	prompt: string;
	url: string;
	max_steps: number;
	data_extraction_schema: Record<string, unknown>;
	webhook_url?: string;
	totp_identifier?: string;
	engine?: SdkRunTaskRequest["body"]["engine"];
	include_action_history_in_verification?: boolean;
};

export type SkyvernArtifactFetcher = (url: string) => Promise<{ body: Buffer; mimeType?: string }>;

export type { SdkRunSdkActionRequest, SdkRunTaskRequest, SdkTotpCodeRequest, SdkUploadFileRequest };

export const NO_RETRY = { maxRetries: 0 } as const;

export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * The generated SDK deliberately returns an HttpResponsePromise whose
 * resolved value is the response body, while its raw-response helper returns
 * `{ data, rawResponse }`. Some deployments/tests also pass that envelope
 * through a loose adapter. Normalize both shapes at this boundary so the
 * rest of the service never accidentally treats the envelope as a Skyvern
 * payload (which otherwise looks like a missing run id/status).
 */
export function unwrapSdkResponse<T>(value: unknown): T {
	if (value && typeof value === "object" && "data" in value) {
		const candidate = value as { data?: unknown; rawResponse?: unknown };
		if ("rawResponse" in candidate || Object.keys(value).length <= 2) return candidate.data as T;
	}
	return value as T;
}

export function objectPayload(value: unknown, label: string): Record<string, unknown> {
	const unwrapped = unwrapSdkResponse<unknown>(value);
	if (!unwrapped || typeof unwrapped !== "object" || Array.isArray(unwrapped)) {
		throw new Error(`Skyvern returned an invalid ${label} response.`);
	}
	return unwrapped as Record<string, unknown>;
}

export function objectPayloadOrUndefined(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function statusOf(value: Record<string, unknown>): SkyvernRunStatus | undefined {
	const status = asString(value.status)?.toLowerCase();
	return status && ["created", "queued", "running", "completed", "failed", "terminated", "timed_out", "canceled"].includes(status)
		? (status as SkyvernRunStatus)
		: undefined;
}

export function runIdOf(value: Record<string, unknown>): string | undefined {
	return asString(value.run_id) ?? asString(value.task_id) ?? asString(value.id);
}
