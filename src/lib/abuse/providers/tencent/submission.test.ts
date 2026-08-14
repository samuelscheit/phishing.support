import { describe, expect, test } from "bun:test";

import type { AbuseArtifact } from "../../schema";
import { providerDefinitionHasValidHash } from "../definition";
import { ProviderSubmissionRejectedError } from "../submission_contracts";
import { TENCENT_PROVIDER } from "./definition";
import { isIntactTencentScreenshotArtifact, makeTencentExplanation, selectTencentScreenshotArtifact } from "./payload";
import { buildTencentCloudHttpPayload, parseTencentCloudSubmissionResponse } from "./submission";

const screenshotBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JH1EAAAAASUVORK5CYII=", "base64");

function screenshotArtifact(overrides: Partial<AbuseArtifact> = {}): AbuseArtifact {
	return {
		id: 101n,
		reportId: 99n,
		targetId: 98n,
		routeId: null,
		runId: null,
		name: "website.png",
		kind: "user_evidence_original",
		mimeType: "image/png",
		sha256: new Bun.CryptoHasher("sha256").update(screenshotBytes).digest("hex"),
		size: screenshotBytes.byteLength,
		metadata: { source: "test" },
		blob: screenshotBytes,
		createdAt: new Date(),
		...overrides,
	};
}

describe("Tencent Cloud abuse submission", () => {
	test("pins the reviewed provider definition", () => {
		expect(providerDefinitionHasValidHash(TENCENT_PROVIDER)).toBeTrue();
	});

	test("selects only an intact PNG screenshot and sends the provider-required form fields", () => {
		const screenshot = selectTencentScreenshotArtifact([screenshotArtifact()]);
		expect(screenshot).toBeDefined();
		if (!screenshot) throw new Error("expected screenshot");
		expect(isIntactTencentScreenshotArtifact(screenshotArtifact())).toBeTrue();
		expect(selectTencentScreenshotArtifact([screenshotArtifact({ mimeType: "image/jpeg" })])).toBeUndefined();
		expect(selectTencentScreenshotArtifact([screenshotArtifact({ sha256: "0".repeat(64) })])).toBeUndefined();
		const alteredBytes = Buffer.from(screenshotBytes);
		alteredBytes[0] = 0;
		expect(isIntactTencentScreenshotArtifact(screenshotArtifact({ blob: alteredBytes, size: alteredBytes.byteLength }))).toBeFalse();

		const payload = buildTencentCloudHttpPayload({
			payload: {
				adapter: "tencent_cloud_dns_abuse_v1",
				definition: { version: TENCENT_PROVIDER.version, contentHash: TENCENT_PROVIDER.contentHash },
				target: {
					normalizedTarget: "login.phishing.example",
					observedUrl: "https://login.phishing.example/path",
					registrableDomain: "phishing.example",
				},
				report: { explanation: "Credential theft impersonating the bank.", legalBrandUrl: "https://bank.example/" },
				screenshot,
			},
			websiteScreenshot: screenshotBytes,
			captcha: { ret: 0, ticket: "ticket", randstr: "rand" },
		}) as { payload: { formData: Record<string, unknown> } };

		expect(payload.payload.formData).toMatchObject({
			domain: "phishing.example",
			category: ["Phishing"],
			privacyCheckbox1: true,
			privacyCheckbox2: true,
			infringedUrl: "https://bank.example/",
			fileBase64: screenshotBytes.toString("base64"),
		});
		expect(String(payload.payload.formData.filename)).toMatch(/^tencent_report_101_[a-f0-9]{12}\.png$/);
	});

	test("keeps the standalone report explanation concise without invoking a legacy draft generator", () => {
		const explanation = makeTencentExplanation(`  ${"credential theft ".repeat(80)} `);
		expect(explanation).toBeDefined();
		expect(explanation!.length).toBeLessThanOrEqual(400);
		expect(explanation).not.toContain("  ");
	});

	test("treats only an explicit Tencent API rejection as provider-rejected", async () => {
		await expect(parseTencentCloudSubmissionResponse(new Response(JSON.stringify({ code: 1, msg: "rejected", data: { code: "7", error: "bad evidence" } })))).rejects
			.toBeInstanceOf(ProviderSubmissionRejectedError);
		await expect(parseTencentCloudSubmissionResponse(new Response("not json"))).rejects
			.toThrow("Tencent Cloud abuse report submission returned malformed JSON.");
		await expect(parseTencentCloudSubmissionResponse(new Response("upstream unavailable", { status: 502 }))).rejects
			.toThrow("Tencent Cloud abuse report submission failed with HTTP 502");
	});
});
