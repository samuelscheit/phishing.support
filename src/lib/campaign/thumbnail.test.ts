import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import { pageThumbnail } from "./thumbnail";

/** A wide capture like the kits draw: a white card on a grey margin, with white to its right. */
async function capture(): Promise<Buffer> {
	const card = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#2563eb" } }).png().toBuffer();
	const left = await sharp({ create: { width: 500, height: 400, channels: 3, background: "#f3f4f6" } }).composite([{ input: card, left: 50, top: 50 }]).png().toBuffer();
	return sharp({ create: { width: 1600, height: 400, channels: 3, background: "#ffffff" } }).composite([{ input: left, left: 0, top: 0 }]).png().toBuffer();
}

describe("page preview", () => {
	test("cuts a capture to what the page drew, without the white viewport or the flat margin", async () => {
		const preview = await pageThumbnail(await capture());
		const meta = await sharp(preview).metadata();
		expect(meta.format).toBe("webp");
		// The card is 400 × 300; the margin and the white area are gone.
		expect(meta.width).toBeGreaterThanOrEqual(396);
		expect(meta.width).toBeLessThanOrEqual(404);
		expect(meta.height).toBeGreaterThanOrEqual(296);
		expect(meta.height).toBeLessThanOrEqual(304);
	});

	test("keeps a capture whole when trimming would leave almost nothing, and never enlarges", async () => {
		const flat = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#ffffff" } }).png().toBuffer();
		expect(await sharp(await pageThumbnail(flat)).metadata()).toMatchObject({ width: 300, height: 200 });
		const wide = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#123456" } }).png().toBuffer();
		expect((await sharp(await pageThumbnail(wide)).metadata()).width).toBe(720);
	});
});
