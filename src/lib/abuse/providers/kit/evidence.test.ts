import { describe, expect, test } from "bun:test";

import type { AbuseArtifact } from "../../schema";
import {
	isIntactProviderEvidenceImageArtifact,
	providerEvidenceImageArtifactMatches,
	providerEvidenceImageHasExpectedMagic,
	selectProviderEvidenceImageArtifact,
	selectProviderEvidenceImageArtifacts,
	storedProviderEvidenceImageReference,
	type ProviderEvidenceImageContract,
} from "./evidence";
import { sha256Hex } from "../../../util/hash";
import { evidenceArtifact } from "./testing";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JH1EAAAAASUVORK5CYII=", "base64");
const contract = {
	acceptedMimeTypes: ["image/jpeg", "image/png", "image/gif", "image/tiff"],
	maximumBytes: 1_000,
	filenamePrefix: "provider_report",
} as const satisfies ProviderEvidenceImageContract;

const artifact = (overrides: Partial<AbuseArtifact> = {}) => evidenceArtifact(png, { name: "evidence.png", ...overrides });

describe("shared provider evidence-image contract", () => {
	test("selects up to the limit of intact images, in order, each image once", () => {
		const other = Buffer.concat([png, Buffer.from([0])]);
		const third = Buffer.concat([png, Buffer.from([1])]);
		const candidates = [
			artifact({ id: 1n, mimeType: "image/gif" }),
			artifact({ id: 2n }),
			artifact({ id: 3n, name: "copy.png" }),
			evidenceArtifact(other, { id: 4n, kind: "outbound_mail_attachment" }),
			evidenceArtifact(other, { id: 5n }),
			evidenceArtifact(third, { id: 6n }),
		];
		expect(selectProviderEvidenceImageArtifacts(candidates, contract, 2).map((reference) => reference.artifactId)).toEqual(["2", "5"]);
		expect(selectProviderEvidenceImageArtifacts(candidates, contract, 5).map((reference) => reference.artifactId)).toEqual(["2", "5", "6"]);
		expect(selectProviderEvidenceImageArtifacts([], contract, 3)).toEqual([]);
		expect(selectProviderEvidenceImageArtifact(candidates, contract)?.artifactId).toBe("2");
		for (const limit of [0, -1, 1.5, Number.NaN]) expect(() => selectProviderEvidenceImageArtifacts(candidates, contract, limit)).toThrow("limit is invalid");
	});

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
