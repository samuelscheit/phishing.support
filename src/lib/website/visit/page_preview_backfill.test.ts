import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import { ArtifactsEntity } from "../../db/entities/artifacts";
import { SubmissionsEntity } from "../../db/entities/submissions";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { backfillPagePreviews } from "./page_preview_backfill";

useTemporaryDatabase();

/** A kit's card drawn at the left of a wide, white viewport. */
async function kitCapture(): Promise<Buffer> {
	const card = await sharp({ create: { width: 420, height: 360, channels: 3, background: "#2563eb" } }).png().toBuffer();
	return sharp({ create: { width: 1917, height: 963, channels: 3, background: "#ffffff" } }).composite([{ input: card, left: 0, top: 0 }]).png().toBuffer();
}

async function websiteCase(id: bigint) {
	await SubmissionsEntity.create({ id, kind: "website", data: { kind: "website", website: { url: `https://kit-${id}.example.com/` } }, dedupeKey: `preview-backfill-${id}`, status: "reported" });
}

const screenshot = (submissionId: bigint, name: string, buffer: Buffer) => ArtifactsEntity.saveBuffer({ submissionId, name, kind: "website_png", mimeType: "image/png", buffer });
const previewsOf = async (submissionId: bigint) => (await ArtifactsEntity.listForSubmission(submissionId)).filter((artifact) => artifact.kind === "website_thumbnail");

describe("backfillPagePreviews", () => {
	test("makes the missing preview of every page, keeps a newer one, renews a stale one, and creates nothing when run again", async () => {
		const image = await kitCapture();
		await websiteCase(1n);
		await websiteCase(2n);
		await websiteCase(3n);
		// Case 1: two routes, three pages, none with a preview.
		for (const name of ["website.png", "website-step2.png", "route2-website-step3.png"]) await screenshot(1n, name, image);
		// Case 2: its page has a preview made after its screenshot.
		await screenshot(2n, "website.png", image);
		const current = await ArtifactsEntity.saveBuffer({ submissionId: 2n, name: "website-thumb.webp", kind: "website_thumbnail", mimeType: "image/webp", buffer: Buffer.from("current") });
		// Case 3: a retry captured the page again after its preview was made; a broken screenshot and an unknown name sit beside it.
		const stale = await ArtifactsEntity.saveBuffer({ submissionId: 3n, name: "website-thumb.webp", kind: "website_thumbnail", mimeType: "image/webp", buffer: Buffer.from("stale") });
		await screenshot(3n, "website.png", image);
		await screenshot(3n, "website-step2.png", Buffer.from([0x89, 0x50]));
		await screenshot(3n, "page-capture.png", image);

		const lines: string[] = [];
		expect(await backfillPagePreviews((line) => lines.push(line))).toEqual({ pages: 7, created: 4, skipped: 1, failed: 1 });
		expect(lines.at(-1)).toStartWith("Done:");

		expect((await previewsOf(1n)).map((artifact) => artifact.name).sort()).toEqual(["route2-website-step3-thumb.webp", "website-step2-thumb.webp", "website-thumb.webp"]);
		const made = (await previewsOf(1n)).find((artifact) => artifact.name === "website-thumb.webp")!;
		expect(made.mimeType).toBe("image/webp");
		const meta = await sharp(Buffer.from((await ArtifactsEntity.get(made.id))!.blob)).metadata();
		expect(meta).toMatchObject({ format: "webp", width: 420, height: 360 });
		expect((await previewsOf(2n)).map((artifact) => artifact.id)).toEqual([current]);
		const renewed = await previewsOf(3n);
		expect(renewed).toHaveLength(2);
		expect(renewed.every((artifact) => artifact.id >= stale)).toBe(true);

		expect(await backfillPagePreviews(() => undefined)).toEqual({ pages: 7, created: 0, skipped: 1, failed: 1 });
	});
});
