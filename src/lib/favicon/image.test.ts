import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import { ICON_EDGE } from "./discover";
import { decodeIcoBitmap, MAX_ICON_BYTES, normalizeIcon, NotAnIconError, sniffIcon } from "./image";
import { raster } from "./test_helpers";

/** An ICO file of the given images: `[edge, bitCount, data]` each, in order. */
function ico(entries: Array<[number, number, Buffer]>): Buffer {
	const header = Buffer.alloc(6 + entries.length * 16);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(entries.length, 4);
	let offset = header.length;
	entries.forEach(([edge, bitCount, data], index) => {
		const at = 6 + index * 16;
		header[at] = edge === 256 ? 0 : edge;
		header[at + 1] = edge === 256 ? 0 : edge;
		header.writeUInt16LE(1, at + 4);
		header.writeUInt16LE(bitCount, at + 6);
		header.writeUInt32LE(data.length, at + 8);
		header.writeUInt32LE(offset, at + 12);
		offset += data.length;
	});
	return Buffer.concat([header, ...entries.map(([, , data]) => data)]);
}

function bitmapHeader(edge: number, bitCount: number, paletteSize = 0): Buffer {
	const header = Buffer.alloc(40);
	header.writeUInt32LE(40, 0);
	header.writeInt32LE(edge, 4);
	header.writeInt32LE(edge * 2, 8);
	header.writeUInt16LE(1, 12);
	header.writeUInt16LE(bitCount, 14);
	header.writeUInt32LE(paletteSize, 32);
	return header;
}

/** A 32-bit BMP icon image: opaque blue, with the top-left pixel transparent by its alpha. */
function bitmap32(edge: number): Buffer {
	const pixels = Buffer.alloc(edge * edge * 4);
	for (let index = 0; index < edge * edge; index++) pixels.set([0xff, 0x00, 0x00, 0xff], index * 4); // BGRA
	// Rows are stored bottom-up: the top row is the last one.
	pixels.set([0, 0, 0, 0], (edge - 1) * edge * 4);
	const mask = Buffer.alloc(Math.ceil(edge / 32) * 4 * edge);
	return Buffer.concat([bitmapHeader(edge, 32), pixels, mask]);
}

/** An 8-bit paletted BMP icon image: red, with its top row transparent by its AND mask. */
function bitmap8(edge: number): Buffer {
	const palette = Buffer.alloc(2 * 4);
	palette.set([0x00, 0x00, 0xff, 0], 4); // index 1: red (BGR0)
	const stride = Math.ceil(edge / 4) * 4;
	const pixels = Buffer.alloc(stride * edge, 1);
	const maskStride = Math.ceil(edge / 32) * 4;
	const mask = Buffer.alloc(maskStride * edge);
	mask.fill(0xff, (edge - 1) * maskStride, (edge - 1) * maskStride + Math.ceil(edge / 8));
	return Buffer.concat([bitmapHeader(edge, 8, 2), palette, pixels, mask]);
}

async function pixel(png: Buffer, x: number, y: number): Promise<number[]> {
	const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const at = (y * info.width + x) * 4;
	return [...data.subarray(at, at + 4)];
}

async function expectIcon(png: Buffer) {
	expect(sniffIcon(png)).toBe("png");
	const meta = await sharp(png).metadata();
	expect([meta.format, meta.width, meta.height]).toEqual(["png", ICON_EDGE, ICON_EDGE]);
}

describe("sniffIcon", () => {
	test("tells the format from the bytes, whatever a server called it", async () => {
		expect(sniffIcon(await raster("png", 32))).toBe("png");
		expect(sniffIcon(await raster("gif", 32))).toBe("gif");
		expect(sniffIcon(await raster("jpeg", 32))).toBe("jpeg");
		expect(sniffIcon(await raster("webp", 32))).toBe("webp");
		expect(sniffIcon(ico([[32, 32, bitmap32(32)]]))).toBe("ico");
		expect(sniffIcon(Buffer.from("\uFEFF<?xml version=\"1.0\"?>\n<!-- logo -->\n<!DOCTYPE svg>\n<svg xmlns=\"http://www.w3.org/2000/svg\"/>"))).toBe("svg");
	});

	test("an HTML page, an SVG inside HTML, an empty ICO directory and text are none", () => {
		expect(sniffIcon(Buffer.from("<!DOCTYPE html><html><body>Attention Required! | Cloudflare</body></html>"))).toBeUndefined();
		expect(sniffIcon(Buffer.from("<html><svg xmlns=\"http://www.w3.org/2000/svg\"/></html>"))).toBeUndefined();
		expect(sniffIcon(Buffer.from([0, 0, 1, 0, 0, 0]))).toBeUndefined();
		expect(sniffIcon(Buffer.from("GIF8"))).toBeUndefined();
		expect(sniffIcon(Buffer.alloc(0))).toBeUndefined();
	});
});

describe("normalizeIcon", () => {
	test.each(["png", "gif", "jpeg", "webp"] as const)("draws a %s again as a 64 px PNG", async (format) => {
		await expectIcon(await normalizeIcon(await raster(format, 48)));
	});

	test("centres a wide image on transparency instead of stretching it", async () => {
		const png = await normalizeIcon(await raster("png", 64, 32, "#0000ff"));
		await expectIcon(png);
		expect(await pixel(png, 32, 2)).toEqual([0, 0, 0, 0]);
		expect(await pixel(png, 32, 32)).toEqual([0, 0, 255, 255]);
	});

	test("rasterises an SVG: no markup, script or link of it is kept", async () => {
		const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 16 16" width="16" height="16"><script>alert(document.cookie)</script><a xlink:href="javascript:alert(1)"><rect width="16" height="16" fill="#f00"/></a></svg>`);
		const png = await normalizeIcon(svg);
		await expectIcon(png);
		expect(png.includes("script")).toBe(false);
		expect(png.includes("alert")).toBe(false);
		expect(await pixel(png, 32, 32)).toEqual([255, 0, 0, 255]);
	});

	test("takes an ICO's image nearest 64 px, a PNG entry as well as a BMP one", async () => {
		const png = await normalizeIcon(ico([[16, 32, bitmap32(16)], [64, 32, await raster("png", 64, 64, "#00ff00")], [128, 32, bitmap32(128)]]));
		expect(await pixel(png, 32, 32)).toEqual([0, 255, 0, 255]);
		const bmp = await normalizeIcon(ico([[16, 32, await raster("png", 16, 16, "#00ff00")], [48, 32, bitmap32(48)]]));
		await expectIcon(bmp);
		expect(await pixel(bmp, 32, 32)).toEqual([0, 0, 255, 255]);
	});

	test("decodes a 32-bit BMP icon with its alpha, rows bottom-up", () => {
		const { data, width, height } = decodeIcoBitmap(bitmap32(16));
		expect([width, height]).toEqual([16, 16]);
		expect([...data.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
		expect([...data.subarray(4, 8)]).toEqual([0, 0, 255, 255]);
	});

	test("decodes a paletted BMP icon, transparent where its AND mask is set", () => {
		const { data } = decodeIcoBitmap(bitmap8(16));
		expect([...data.subarray(0, 4)]).toEqual([255, 0, 0, 0]);
		expect([...data.subarray(16 * 4, 16 * 4 + 4)]).toEqual([255, 0, 0, 255]);
	});

	test.each([
		["an HTML error page", Buffer.from("<!DOCTYPE html><html><head><title>404</title></head></html>")],
		["text served as image/png", Buffer.from("not an image at all")],
		["a PNG signature with nothing after it", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
		["an ICO whose directory runs past the file", Buffer.from([0, 0, 1, 0, 4, 0, 16, 16])],
		["an ICO whose image runs past the file", ico([[16, 32, bitmap32(16)]]).subarray(0, 100)],
		["an ICO with a compressed bitmap", ico([[16, 32, Buffer.concat([bitmapHeader(16, 32).fill(1, 16, 17), Buffer.alloc(1200)])]])],
	])("refuses %s", async (_name, bytes) => {
		await expect(normalizeIcon(bytes)).rejects.toBeInstanceOf(NotAnIconError);
	});

	test("refuses a file over the size bound before decoding it", async () => {
		const big = Buffer.concat([await raster("png", 32), Buffer.alloc(MAX_ICON_BYTES)]);
		await expect(normalizeIcon(big)).rejects.toThrow(/more than/);
	});

	test("refuses a tracking pixel and a spacer: too small for an icon", async () => {
		await expect(normalizeIcon(await raster("gif", 1))).rejects.toThrow(/too small/);
		await expect(normalizeIcon(await raster("png", 8))).rejects.toThrow(/too small/);
	});

	test("refuses an image of more pixels than an icon could need, before drawing it", async () => {
		const bomb = await sharp({ create: { width: 4096, height: 4096, channels: 3, background: "#000" } }).png({ compressionLevel: 9 }).toBuffer();
		expect(bomb.length).toBeLessThan(MAX_ICON_BYTES);
		await expect(normalizeIcon(bomb)).rejects.toBeInstanceOf(NotAnIconError);
	});
});
