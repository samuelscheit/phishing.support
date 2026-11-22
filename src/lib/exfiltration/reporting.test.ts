import { describe, expect, test } from "bun:test";

import { buildExfiltrationBackendRequest } from "./reporting";
import type { ExfiltrationBackend } from "./types";
import { sha256Hex } from "../util/hash";

describe("exfiltration backend reports", () => {
	test("models a Telegram bot as a service account and retains actionable evidence", () => {
		const endpointUrl = "https://api.telegram.org/bot123456:secret/sendMessage";
		const backend: ExfiltrationBackend = {
			kind: "telegram_bot",
			key: "telegram-token:123456:secret",
			endpointUrl,
			hostname: "api.telegram.org",
			method: "POST",
			matchedCanaries: ["email", "password"],
			request: { timestamp: "2026-10-28T00:00:00.000Z", method: "POST", url: endpointUrl, postData: "synthetic" },
			telegram: { token: "123456:secret", botId: "123456", username: "collector_bot", chatId: "-7" },
		};
		const request = buildExfiltrationBackendRequest({ submissionId: 1n, sourceReportId: 2n, backend, pageUrl: "https://phish.example/", observedAt: new Date("2026-10-28T00:00:00Z") });
		expect(request.targets[0]).toMatchObject({ normalizedTarget: "telegram-bot:123456", targetType: "service_account" });
		expect(request.description).toContain("@collector_bot");
		expect(request.description).toContain("chat ID -7");
		expect(request.idempotencyKey).toStartWith("exfil:1:");
		expect(request.evidence[0]?.mimeType).toBe("application/json");
	});

	test("routes an attacker-owned collector by its own domain", () => {
		const endpointUrl = "https://api.brandogdigital.org/collect";
		const backend: ExfiltrationBackend = { kind: "domain", key: "domain:api.brandogdigital.org", endpointUrl, hostname: "api.brandogdigital.org", method: "POST", matchedCanaries: ["password"], request: { timestamp: "now", method: "POST", url: endpointUrl } };
		const request = buildExfiltrationBackendRequest({ submissionId: 1n, sourceReportId: 2n, backend, pageUrl: "https://cmail-geogle.com/", observedAt: new Date() });
		expect(request.targets[0]).toMatchObject({ normalizedTarget: "api.brandogdigital.org", targetType: "domain" });
		expect(request.evidence.map((item) => item.filename)).toEqual(["exfiltration-evidence.json"]);
	});

	test("carries the confirmed page's screenshot as image evidence, without changing the report's identity", () => {
		const endpointUrl = "https://zealousvoice.com/Mortage/Ins";
		const backend: ExfiltrationBackend = { kind: "domain", key: "domain:zealousvoice.com", endpointUrl, hostname: "zealousvoice.com", method: "POST", matchedCanaries: ["email"], request: { timestamp: "now", method: "POST", url: endpointUrl } };
		const base = { submissionId: 1n, sourceReportId: 2n, backend, pageUrl: "https://indemnity-insurance.pages.dev/", observedAt: new Date("2026-11-20T21:25:22.993Z") };
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
		const jpeg = Buffer.from([0xff, 0xd8, 0xff, 2]);
		const withPng = buildExfiltrationBackendRequest({ ...base, pageScreenshot: { buffer: png, mimeType: "image/png" } });
		expect(withPng.evidence.slice(1)).toEqual([{ filename: "lure-page.png", mimeType: "image/png", buffer: png, sha256: sha256Hex(png) }]);
		expect(buildExfiltrationBackendRequest({ ...base, pageScreenshot: { buffer: jpeg, mimeType: "image/jpeg" } }).evidence[1]).toMatchObject({ filename: "lure-page.jpg", mimeType: "image/jpeg" });
		const without = buildExfiltrationBackendRequest(base);
		expect(withPng.idempotencyKey).toBe(without.idempotencyKey);
		expect(withPng.requestPayloadHash).toBe(without.requestPayloadHash);
	});
});
