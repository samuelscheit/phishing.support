import crypto from "node:crypto";

import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import {
	MAX_EVIDENCE_BYTES_PER_ITEM,
	normalizeAbuseTarget,
	validateAbuseReportRequest,
} from "./contracts";
import { AbuseInputError, isPublicIp, normalizeDomain } from "./security";

const baseRequest = {
	targets: ["example.com"],
	allegationCategory: "phishing" as const,
	description: "A credential-harvesting page impersonates the service.",
};

async function pngBuffer(width = 2, height = 2): Promise<Buffer> {
	return sharp({
		create: {
			width,
			height,
			channels: 3,
			background: { r: 20, g: 40, b: 60 },
		},
	}).png().toBuffer();
}

describe("standalone abuse-report input contract", () => {
	test("normalizes IDNA, case, and trailing dots while retaining ordered original provenance", async () => {
		expect(normalizeDomain(" BÜCHER.DE. ")).toBe("xn--bcher-kva.de");
		expect(normalizeAbuseTarget("EXAMPLE.COM.")).toEqual({ normalizedTarget: "example.com", targetType: "domain" });

		const request = await validateAbuseReportRequest({
			...baseRequest,
			targets: ["EXAMPLE.COM.", "example.com", "8.8.8.8", "EXAMPLE.COM"],
			observedUrls: [
				{ target: "example.com.", urls: ["https://LOGIN.Example.COM/path#fragment"] },
			],
		});

		expect(request.targets).toEqual([
			{
				ordinal: 0,
				originalInput: "EXAMPLE.COM.",
				originalInputs: ["EXAMPLE.COM.", "example.com", "EXAMPLE.COM"],
				normalizedTarget: "example.com",
				targetType: "domain",
				observedUrls: ["https://login.example.com/path"],
			},
			{
				ordinal: 2,
				originalInput: "8.8.8.8",
				originalInputs: ["8.8.8.8"],
				normalizedTarget: "8.8.8.8",
				targetType: "ip",
				observedUrls: [],
			},
		]);
	});

	test("accepts public IPv4 and IPv6 while rejecting local, special-use, and scoped ranges", () => {
		for (const value of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e"]) {
			expect(isPublicIp(value), value).toBeTrue();
		}
		for (const value of [
			"0.0.0.0",
			"10.1.2.3",
			"100.64.0.1",
			"127.0.0.1",
			"169.254.10.10",
			"172.16.0.1",
			"192.0.2.1",
			"192.168.1.1",
			"198.18.0.1",
			"198.51.100.1",
			"203.0.113.1",
			"224.0.0.1",
			"240.0.0.1",
			"::",
			"::1",
			"::ffff:127.0.0.1",
			"64:ff9b::808:808",
			"100::1",
			"2001:db8::1",
			"2002::1",
			"fc00::1",
			"fe80::1",
			"ff02::1",
			"fe80::1%en0",
		]) {
			expect(isPublicIp(value), value).toBeFalse();
			expect(() => normalizeAbuseTarget(value), value).toThrow(AbuseInputError);
		}
	});

	test("rejects unsupported client-controlled fields and observed URLs outside submitted domains", async () => {
		await expect(validateAbuseReportRequest({ ...baseRequest, providerUrl: "https://attacker.invalid" })).rejects.toThrow(AbuseInputError);
		await expect(validateAbuseReportRequest({
			...baseRequest,
			observedUrls: [{ target: "example.com", urls: ["https://evil.example.net/collect"] }],
		})).rejects.toThrow("not associated with submitted domain");
		await expect(validateAbuseReportRequest({
			...baseRequest,
			observedUrls: [{ target: "example.com", urls: ["file:///etc/passwd"] }],
		})).rejects.toThrow("must use http or https");
	});

	test("requires strict base64 and decoded MIME agreement rather than trusting filenames", async () => {
		await expect(validateAbuseReportRequest({
			...baseRequest,
			evidence: [{ filename: "looks-like-an-image.png", mimeType: "image/png", base64: "not base64!" }],
		})).rejects.toThrow("plain base64");

		const png = await pngBuffer();
		await expect(validateAbuseReportRequest({
			...baseRequest,
			evidence: [{ filename: "misleading.jpg", mimeType: "image/jpeg", base64: png.toString("base64") }],
		})).rejects.toThrow("MIME type does not match");

		const tooLarge = Buffer.alloc(MAX_EVIDENCE_BYTES_PER_ITEM + 1, 1).toString("base64");
		await expect(validateAbuseReportRequest({
			...baseRequest,
			evidence: [{ filename: "large.png", mimeType: "image/png", base64: tooLarge }],
		})).rejects.toThrow();
	});

	test("enforces the aggregate decoded-evidence limit after each image has been validated", async () => {
		// Five deliberately incompressible 1250x1250 RGB PNGs are each below the
		// 5 MiB item limit but together exceed the 20 MiB report limit. This proves
		// the aggregate check runs on decoded bytes rather than filename claims or
		// compressed request shape.
		const evidence = await Promise.all(
			Array.from({ length: 5 }, async (_, index) => {
				const pixels = crypto.randomBytes(1_250 * 1_250 * 3);
				const buffer = await sharp(pixels, { raw: { width: 1_250, height: 1_250, channels: 3 } })
					.png({ compressionLevel: 0 })
					.toBuffer();
				expect(buffer.byteLength).toBeLessThan(MAX_EVIDENCE_BYTES_PER_ITEM);
				return { filename: `evidence-${index}.png`, mimeType: "image/png", base64: buffer.toString("base64") };
			}),
		);

		await expect(validateAbuseReportRequest({ ...baseRequest, evidence })).rejects.toThrow("Evidence exceeds the 20 MB report limit");
	});
});
