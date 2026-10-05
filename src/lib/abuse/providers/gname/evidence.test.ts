import { describe, expect, test } from "bun:test";

import sharp from "sharp";

import { verifyGnameEvidence, type CapturedGnameEvidence } from "./evidence";

async function freshCapture(overrides: Partial<CapturedGnameEvidence> = {}): Promise<CapturedGnameEvidence> {
	const screenshot = await sharp({
		create: { width: 8, height: 8, channels: 3, background: { r: 220, g: 25, b: 25 } },
	}).png().toBuffer();
	return {
		url: "https://login.example.com/collect",
		screenshot,
		mimeType: "image/png",
		capturedAt: new Date(),
		pageText: "Credential collection page",
		pageTitle: "Example login",
		...overrides,
	};
}

function validEvidenceInput(captures: CapturedGnameEvidence[]) {
	return {
		target: "example.com",
		observedUrls: ["https://login.example.com/collect"],
		legalBrandUrl: "https://brand.example.com/",
		description: "The site collects credentials while impersonating the protected brand.",
		userEvidence: [],
		captures,
		classification: { phishing: true, confidence: 1 },
	};
}

describe("GNAME evidence verification", () => {
	test("creates a deterministic GNAME-compatible derivative from a fresh, classified capture", async () => {
		const result = await verifyGnameEvidence(validEvidenceInput([await freshCapture()]));

		expect(result.passed).toBeTrue();
		expect(result.reasons).toEqual([]);
		expect(result.derivatives).toHaveLength(1);
		expect(result.derivatives[0]).toMatchObject({
			name: "evidence-1.png",
			mimeType: "image/png",
			metadata: { sourceFilename: "capture-1.png", provider: "gname" },
		});
		expect(result.derivatives[0]?.buffer.byteLength).toBeGreaterThan(0);
	});

	test("fails closed for stale captures and URLs not associated with the submitted target", async () => {
		const stale = await freshCapture({ capturedAt: new Date(Date.now() - 15 * 60_000 - 1) });
		const result = await verifyGnameEvidence({
			...validEvidenceInput([stale]),
			observedUrls: ["https://unrelated.example.net/collect"],
		});

		expect(result.passed).toBeFalse();
		expect(result.reasons).toEqual(expect.arrayContaining([
			"capture_not_fresh",
			"observed_url_not_associated_with_target",
		]));
	});
});
