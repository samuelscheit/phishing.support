import { describe, expect, test } from "bun:test";

import { ArtifactsEntity } from "./artifacts";
import { SubmissionsEntity } from "./submissions";
import { useTemporaryDatabase } from "../test_helpers";

useTemporaryDatabase();

describe("ArtifactsEntity.saveWebsiteArtifacts", () => {
	test("stores every chain body as opaque bytes, exactly as delivered, whatever it was served as", async () => {
		const submissionId = 7n;
		await SubmissionsEntity.create({ id: submissionId, kind: "website", data: { kind: "website", website: { url: "https://short.example.com/" } }, dedupeKey: "artifacts-entity-test", status: "running" });
		const kit = Buffer.from("<html><script>fetch('/api/submissions').then(r => r.text()).then(steal)</script></html>");
		// Not UTF-8, and served as something else entirely.
		const binary = Buffer.from([0xff, 0xfe, 0x00, 0x3c, 0x73]);
		await ArtifactsEntity.saveWebsiteArtifacts({
			submissionId,
			archive: { archivedAt: new Date("2026-01-02T03:04:05Z"), mhtml: Buffer.from("MIME-Version: 1.0"), screenshotPng: Buffer.from([0x89, 0x50]), hopBodies: [{ hopIndex: 1, body: kit }, { hopIndex: 3, body: binary }] },
			evidence: { page: { route: 0, step: 0 }, manifest: Buffer.from("{}\n") },
		});

		const files = await ArtifactsEntity.listForSubmission(submissionId);
		const types = Object.fromEntries(files.map((file) => [file.name, [file.kind, file.mimeType]]));
		// The capture's own files keep their types.
		expect(types).toEqual({
			"chain-hop-1.html": ["website_hop_body", "application/octet-stream"],
			"chain-hop-3.html": ["website_hop_body", "application/octet-stream"],
			"website.mhtml": ["website_mhtml", "text/mhtml"],
			"website.png": ["website_png", "image/png"],
			"evidence-manifest.json": ["website_evidence", "application/json"],
		});

		const body = async (name: string) => (await ArtifactsEntity.get(files.find((file) => file.name === name)!.id))!.blob;
		expect(Buffer.from(await body("chain-hop-1.html"))).toEqual(kit);
		expect(Buffer.from(await body("chain-hop-3.html"))).toEqual(binary);
	});
});
