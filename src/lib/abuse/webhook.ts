import crypto from "node:crypto";

import { AbuseInputError, sha256Hex } from "./security";
import { configuredSkyvernApiKey } from "./skyvern_config";

const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

function configuredKey(): string {
	return configuredSkyvernApiKey();
}

function decodeSignature(value: string): Buffer | undefined {
	// Skyvern v1.0.24 emits the lower-case hexadecimal digest returned by
	// hashlib.hexdigest().  Do not accept alternate encodings or prefixes: a
	// permissive decoder would make compatibility ambiguous and would weaken
	// the signed-webhook contract.
	const normalized = value.trim();
	if (!/^[0-9a-f]{64}$/i.test(normalized)) return undefined;
	return Buffer.from(normalized, "hex");
}

/**
 * Match Skyvern's `_normalize_json_dumps` implementation exactly for the
 * JSON values representable by a webhook request:
 *
 *   json.dumps(_normalize_numbers(payload), separators=(",", ":"),
 *              ensure_ascii=False)
 *
 * JSON.parse already preserves object insertion order, and JSON.stringify
 * uses the same compact separators and UTF-8 (non-ASCII) representation.
 * Integral JSON numbers are emitted without a decimal point by JSON.stringify,
 * which is the observable result of Skyvern's recursive float-to-int pass.
 */
export function canonicalizeSkyvernPayload(payload: Record<string, unknown>): string {
	const normalizeNumbers = (value: unknown): unknown => {
		if (typeof value === "number") {
			if (!Number.isFinite(value)) throw new AbuseInputError("Skyvern webhook contains a non-finite number.");
			return Number.isInteger(value) ? Math.trunc(value) : value;
		}
		if (Array.isArray(value)) return value.map(normalizeNumbers);
		if (value && typeof value === "object") {
			const result: Record<string, unknown> = {};
			for (const [key, nested] of Object.entries(value)) result[key] = normalizeNumbers(nested);
			return result;
		}
		return value;
	};
	return JSON.stringify(normalizeNumbers(payload));
}

/**
 * Verify a Skyvern v1.0.24 webhook. Skyvern creates its compact,
 * number-normalized JSON before sending it, then signs that exact UTF-8 body.
 * The timestamp is a required freshness header but is deliberately not part of
 * the HMAC input. Verify the raw bytes rather than reserializing parsed JSON:
 * accepting a semantically equivalent body with different whitespace or key
 * formatting would authenticate bytes Skyvern never signed.
 */
export function verifySkyvernWebhookSignature(params: {
	body: Uint8Array;
	signature: string | null;
	timestamp: string | null;
	apiKey?: string;
	nowSeconds?: number;
	toleranceSeconds?: number;
}): { timestamp: number; payloadHash: string } {
	if (!params.signature || !params.timestamp) throw new AbuseInputError("Missing Skyvern webhook signature.");
	if (!/^\d{1,12}$/.test(params.timestamp)) throw new AbuseInputError("Malformed Skyvern webhook timestamp.");
	const timestamp = Number(params.timestamp);
	const now = params.nowSeconds ?? Math.floor(Date.now() / 1_000);
	const tolerance = params.toleranceSeconds ?? DEFAULT_TIMESTAMP_TOLERANCE_SECONDS;
	if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > tolerance) throw new AbuseInputError("Expired Skyvern webhook signature.");
	const received = decodeSignature(params.signature);
	if (!received) throw new AbuseInputError("Malformed Skyvern webhook signature.");
	const key = params.apiKey ?? configuredKey();
	const expected = crypto.createHmac("sha256", key).update(params.body).digest();
	if (received.byteLength !== expected.byteLength || !crypto.timingSafeEqual(received, expected)) {
		throw new AbuseInputError("Invalid Skyvern webhook signature.");
	}
	return { timestamp, payloadHash: sha256Hex(Buffer.from(params.body)) };
}

export function webhookEventId(payload: Record<string, unknown>, bodyHash: string, timestamp: number, suppliedId?: string | null): string {
	const explicit = suppliedId?.trim();
	if (explicit && /^[A-Za-z0-9._:-]{1,200}$/.test(explicit)) return explicit;
	const candidate = typeof payload.event_id === "string" ? payload.event_id : typeof payload.id === "string" ? payload.id : undefined;
	if (candidate && /^[A-Za-z0-9._:-]{1,200}$/.test(candidate)) return candidate;
	return `derived:${bodyHash}`;
}

export function skyvernRunIdFromWebhook(payload: Record<string, unknown>): string | undefined {
	for (const value of [payload.run_id, payload.task_id, payload.workflow_run_id, (payload.data as Record<string, unknown> | undefined)?.run_id]) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}
