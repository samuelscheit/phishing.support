import { describe, expect, test } from "bun:test";

import type { AbuseArtifact } from "../schema";
import {
	isIntactProviderEvidenceImageArtifact,
	providerEvidenceImageArtifactMatches,
	providerEvidenceImageHasExpectedMagic,
	selectProviderEvidenceImageArtifact,
	storedProviderEvidenceImageReference,
	type ProviderEvidenceImageContract,
} from "./evidence_image";
import { sha256Hex } from "../../util/hash";
import { evidenceArtifact } from "./kit/testing";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JH1EAAAAASUVORK5CYII=", "base64");
const contract = {
	acceptedMimeTypes: ["image/jpeg", "image/png", "image/gif", "image/tiff"],
	maximumBytes: 1_000,
	filenamePrefix: "provider_report",
} as const satisfies ProviderEvidenceImageContract;

const artifact = (overrides: Partial<AbuseArtifact> = {}) => evidenceArtifact(png, { name: "evidence.png", ...overrides });

describe("shared provider evidence-image contract", () => {
	test("recognizes every provider-supported signature and rejects mismatched declarations", () => {
		expect(providerEvidenceImageHasExpectedMagic(Buffer.from("GIF89a payload"), "image/gif")).toBeTrue();
		expect(providerEvidenceImageHasExpectedMagic(Buffer.from([0xff, 0xd8, 0xff, 0x00]), "image/jpeg")).toBeTrue();
		expect(providerEvidenceImageHasExpectedMagic(png, "image/png")).toBeTrue();
		expect(providerEvidenceImageHasExpectedMagic(Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x00]), "image/tiff")).toBeTrue();
		expect(providerEvidenceImageHasExpectedMagic(Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00]), "image/tiff")).toBeTrue();
		expect(providerEvidenceImageHasExpectedMagic(png, "image/jpeg")).toBeFalse();
	});

	test("binds selected bytes to immutable metadata and a generated filename", () => {
		const selected = selectProviderEvidenceImageArtifact([artifact()], contract);
		expect(selected).toEqual({
			artifactId: "101",
			name: "evidence.png",
			mimeType: "image/png",
			sha256: sha256Hex(png),
			size: png.byteLength,
			filename: `provider_report_101_${sha256Hex(png).slice(0, 12)}.png`,
		});
		expect(storedProviderEvidenceImageReference(selected, contract)).toEqual(selected);
		expect(providerEvidenceImageArtifactMatches(selected!, artifact(), contract)).toBeTrue();
	});

	test("fails closed on altered bytes, MIME metadata, hashes, kinds, sizes, and references", () => {
		const changed = Buffer.from(png);
		changed[0] = 0;
		for (const candidate of [
			artifact({ blob: changed, size: changed.byteLength }),
			artifact({ mimeType: "image/jpeg" }),
			artifact({ sha256: "0".repeat(64) }),
			artifact({ kind: "provider_evidence_derivative" }),
			artifact({ size: png.byteLength + 1 }),
		]) {
			expect(isIntactProviderEvidenceImageArtifact(candidate, contract)).toBeFalse();
			expect(selectProviderEvidenceImageArtifact([candidate], contract)).toBeUndefined();
		}

		const selected = selectProviderEvidenceImageArtifact([artifact()], contract)!;
		expect(storedProviderEvidenceImageReference({ ...selected, filename: "attacker.png" }, contract)).toBeUndefined();
		expect(storedProviderEvidenceImageReference({ ...selected, sha256: selected.sha256.toUpperCase() }, contract)).toBeUndefined();
		expect(() => selectProviderEvidenceImageArtifact([artifact()], { ...contract, filenamePrefix: "../bad" })).toThrow("contract is invalid");
	});
});
