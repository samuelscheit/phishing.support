import { describe, expect, test } from "bun:test";
import sharp from "sharp";

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

	test("stores the page's preview next to its screenshot; a screenshot no preview can be cut from leaves the capture whole", async () => {
		await SubmissionsEntity.create({ id: 8n, kind: "website", data: { kind: "website", website: { url: "https://kit.example.com/" } }, dedupeKey: "artifacts-entity-preview", status: "running" });
		const card = await sharp({ create: { width: 500, height: 400, channels: 3, background: "#1a73e8" } }).png().toBuffer();
		const screenshotPng = await sharp({ create: { width: 1917, height: 963, channels: 3, background: "#ffffff" } }).composite([{ input: card, left: 0, top: 0 }]).png().toBuffer();
		const capture = (screenshot: Buffer, step: number) => ArtifactsEntity.saveWebsiteArtifacts({
			submissionId: 8n,
			archive: { archivedAt: new Date("2026-01-02T03:04:05Z"), mhtml: Buffer.from("MIME-Version: 1.0"), screenshotPng: screenshot },
			evidence: { page: { route: 1, step }, manifest: Buffer.from("{}\n") },
		});
		const { screenshotId } = await capture(screenshotPng, 1);
		await capture(Buffer.from([0x89, 0x50]), 2);

		const files = await ArtifactsEntity.listForSubmission(8n);
		const preview = files.find((file) => file.name === "route2-website-step2-thumb.webp")!;
		expect(preview).toMatchObject({ kind: "website_thumbnail", mimeType: "image/webp", archivedAt: new Date("2026-01-02T03:04:05Z") });
		expect(preview.id > screenshotId!).toBe(true);
		expect(await sharp(Buffer.from((await ArtifactsEntity.get(preview.id))!.blob)).metadata()).toMatchObject({ format: "webp", width: 500, height: 400 });
		expect(files.map((file) => file.name)).toContain("route2-website-step3.png");
		expect(files.map((file) => file.name)).not.toContain("route2-website-step3-thumb.webp");
		expect(await ArtifactsEntity.ensurePagePreview(8n, { route: 1, step: 1 })).toEqual({ previewId: preview.id, screenshotId: screenshotId!, created: false });
		expect(await ArtifactsEntity.ensurePagePreview(8n, { route: 0, step: 0 })).toBeUndefined();
	});
});
