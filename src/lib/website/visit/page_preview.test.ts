import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import { isBlankCapture, pagePreview } from "./page_preview";

/** A sign-in card as kits draw it: a heading, two fields and a button on white. */
async function signInCapture(): Promise<Buffer> {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
		<rect width="800" height="600" fill="#ffffff"/>
		<rect x="200" y="100" width="400" height="400" rx="8" fill="#ffffff" stroke="#dadce0"/>
		<text x="400" y="170" font-size="24" text-anchor="middle" fill="#202124">Sign in</text>
		<rect x="240" y="220" width="320" height="48" rx="4" fill="#ffffff" stroke="#80868b"/>
		<text x="256" y="250" font-size="16" fill="#5f6368">Email or phone</text>
		<rect x="240" y="290" width="320" height="48" rx="4" fill="#ffffff" stroke="#80868b"/>
		<rect x="460" y="420" width="100" height="40" rx="4" fill="#1a73e8"/>
		<text x="510" y="446" font-size="14" text-anchor="middle" fill="#ffffff">Next</text>
	</svg>`;
	return sharp(Buffer.from(svg)).png().toBuffer();
}

/** One flat colour at the size kits' pages are captured, as a page that never rendered leaves it. */
function flatCapture(background = "#ffffff", width = 1905, height = 967): Promise<Buffer> {
	return sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
}

describe("a blank capture", () => {
	test("one flat colour is blank, whatever the colour or format", async () => {
		expect(await isBlankCapture(await flatCapture())).toBe(true);
		expect(await isBlankCapture(await flatCapture("#1f1f1f"))).toBe(true);
		expect(await isBlankCapture(await sharp(await flatCapture()).jpeg({ quality: 70 }).toBuffer())).toBe(true);
		expect(await isBlankCapture(await sharp({ create: { width: 400, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer())).toBe(true);
	});

	test("a sign-in card on white, or a single line on a flat page, is not", async () => {
		expect(await isBlankCapture(await signInCapture())).toBe(false);
		const line = await sharp({ create: { width: 1905, height: 1, channels: 3, background: "#000000" } }).png().toBuffer();
		expect(await isBlankCapture(await sharp(await flatCapture()).composite([{ input: line, left: 0, top: 400 }]).png().toBuffer())).toBe(false);
	});
});

/** A wide capture like the kits draw: a white card on a grey margin, with white to its right. */
async function capture(): Promise<Buffer> {
	const card = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#2563eb" } }).png().toBuffer();
	const left = await sharp({ create: { width: 500, height: 400, channels: 3, background: "#f3f4f6" } }).composite([{ input: card, left: 50, top: 50 }]).png().toBuffer();
	return sharp({ create: { width: 1600, height: 400, channels: 3, background: "#ffffff" } }).composite([{ input: left, left: 0, top: 0 }]).png().toBuffer();
}

describe("page preview", () => {
	test("cuts a capture to what the page drew, without the white viewport or the flat margin", async () => {
		const preview = await pagePreview(await capture());
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
		expect(await sharp(await pagePreview(flat)).metadata()).toMatchObject({ width: 300, height: 200 });
	});

	test("keeps a full-width page sharp up to 1280 px, and a kit's card at its own size", async () => {
		const wide = await sharp({ create: { width: 1917, height: 963, channels: 3, background: "#123456" } }).png().toBuffer();
		expect(await sharp(await pagePreview(wide)).metadata()).toMatchObject({ width: 1280, height: 643 });
		const card = await sharp({ create: { width: 860, height: 700, channels: 3, background: "#2563eb" } }).png().toBuffer();
		const kit = await sharp({ create: { width: 1917, height: 963, channels: 3, background: "#ffffff" } }).composite([{ input: card, left: 0, top: 0 }]).png().toBuffer();
		expect(await sharp(await pagePreview(kit)).metadata()).toMatchObject({ width: 860, height: 700 });
	});
});
