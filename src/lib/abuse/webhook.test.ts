import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";

import { AbuseInputError } from "./security";
import {
	canonicalizeSkyvernPayload,
	skyvernRunIdFromWebhook,
	verifySkyvernWebhookSignature,
	webhookEventId,
} from "./webhook";

const API_KEY = "test-skyvern-key";
const NOW = 1_700_000_000;

function skyvernSignature(payload: Record<string, unknown>): { body: Buffer; signature: string } {
	const body = Buffer.from(canonicalizeSkyvernPayload(payload), "utf8");
	return {
		body,
		signature: crypto.createHmac("sha256", API_KEY).update(body).digest("hex"),
	};
}

describe("Skyvern webhook compatibility", () => {
	test("matches the pinned v1.0.24 compact JSON and number normalization", () => {
		const payload = {
			run_id: "tsk_123",
			float_integral: 1.0,
			nested: { values: [2.0, 2.5] },
			message: "phishé/测试",
		};
		expect(canonicalizeSkyvernPayload(payload)).toBe(
			'{"run_id":"tsk_123","float_integral":1,"nested":{"values":[2,2.5]},"message":"phishé/测试"}',
		);
		const signed = skyvernSignature(payload);
		const verified = verifySkyvernWebhookSignature({
			body: signed.body,
			signature: signed.signature,
			timestamp: String(NOW),
			apiKey: API_KEY,
			nowSeconds: NOW,
		});
		expect(verified.timestamp).toBe(NOW);
	});

	test("does not include the freshness timestamp in the signed payload", () => {
		const payload = { run_id: "tsk_456", status: "completed" };
		const signed = skyvernSignature(payload);
		for (const timestamp of [NOW - 1, NOW, NOW + 1]) {
			expect(() =>
				verifySkyvernWebhookSignature({
					body: signed.body,
					signature: signed.signature,
					timestamp: String(timestamp),
					apiKey: API_KEY,
					nowSeconds: NOW,
				}),
			).not.toThrow();
		}
	});

	test("rejects a body whose bytes differ from Skyvern's signed compact payload", () => {
		const payload = { run_id: "tsk_789", value: 3.0 };
		const signed = skyvernSignature(payload);
		const prettyBody = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
		expect(() =>
			verifySkyvernWebhookSignature({
				body: prettyBody,
				signature: signed.signature,
				timestamp: String(NOW),
				apiKey: API_KEY,
				nowSeconds: NOW,
			}),
		).toThrow("Invalid Skyvern webhook signature");
	});

	test("rejects malformed, stale, and mismatched signatures", () => {
		const signed = skyvernSignature({ run_id: "tsk_bad" });
		const base = {
			body: signed.body,
			timestamp: String(NOW),
			apiKey: API_KEY,
			nowSeconds: NOW,
		};
		expect(() => verifySkyvernWebhookSignature({ ...base, signature: "sha256=" + signed.signature })).toThrow(AbuseInputError);
		expect(() => verifySkyvernWebhookSignature({ ...base, signature: "not-a-digest" })).toThrow("Malformed Skyvern webhook signature");
		expect(() => verifySkyvernWebhookSignature({ ...base, signature: signed.signature, timestamp: String(NOW - 301) })).toThrow("Expired Skyvern webhook signature");
		expect(() => verifySkyvernWebhookSignature({ ...base, signature: "0".repeat(64) })).toThrow("Invalid Skyvern webhook signature");
		// Authentication is deliberately performed before JSON parsing. A body
		// that was not signed by Skyvern must not reveal parser behavior.
		expect(() => verifySkyvernWebhookSignature({ ...base, signature: signed.signature, body: Buffer.from("not-json") })).toThrow("Invalid Skyvern webhook signature");
	});

	test("derives a stable event identity and extracts nested run IDs", () => {
		expect(webhookEventId({ event_id: "evt_explicit" }, "hash", NOW)).toBe("evt_explicit");
		expect(webhookEventId({}, "hash", NOW)).toBe("derived:hash");
		expect(skyvernRunIdFromWebhook({ data: { run_id: "tsk_nested" } })).toBe("tsk_nested");
	});
});
