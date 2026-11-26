import sharp, { type Sharp } from "sharp";

import { ICON_EDGE } from "./discover";

/** The most an icon file may weigh; anything bigger is not a favicon. */
export const MAX_ICON_BYTES = 256 * 1024;
/** An image this small is a tracking pixel or a spacer, not an icon. */
const MIN_SOURCE_EDGE = 16;
/** Pixels sharp may decode from one file: a 2048 px square, so a crafted SVG or PNG cannot exhaust memory. */
const MAX_SOURCE_PIXELS = 2048 * 2048;

export class NotAnIconError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotAnIconError";
	}
}

export type IconFormat = "png" | "gif" | "jpeg" | "webp" | "avif" | "ico" | "svg";

const startsWith = (bytes: Buffer, signature: readonly number[], offset = 0) => signature.every((byte, index) => bytes[offset + index] === byte);
const ascii = (bytes: Buffer, text: string, offset = 0) => bytes.subarray(offset, offset + text.length).toString("latin1") === text;

/**
 * What an icon file really is, from its first bytes; never from the
 * Content-Type or file name its server gives. An HTML error page served as
 * `image/png` is none.
 */
export function sniffIcon(bytes: Buffer): IconFormat | undefined {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
	if (ascii(bytes, "GIF87a") || ascii(bytes, "GIF89a")) return "gif";
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
	if (ascii(bytes, "RIFF") && ascii(bytes, "WEBP", 8)) return "webp";
	if (ascii(bytes, "ftyp", 4) && /^(?:avif|avis)$/.test(bytes.subarray(8, 12).toString("latin1"))) return "avif";
	if (startsWith(bytes, [0, 0, 1, 0]) && bytes.readUInt16LE(4) > 0) return "ico";
	// An SVG document: its root element, after an optional BOM, XML declaration, comments and doctype.
	const head = bytes.subarray(0, 4096).toString("utf8").replace(/^\uFEFF/, "").replace(/^(?:\s+|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/i, "");
	if (/^<svg[\s>]/i.test(head)) return "svg";
	return undefined;
}

type IcoEntry = { width: number; height: number; bitCount: number; data: Buffer };

/** The images of an ICO file, each within its bounds. */
function icoEntries(bytes: Buffer): IcoEntry[] {
	const count = bytes.readUInt16LE(4);
	if (6 + count * 16 > bytes.length) throw new NotAnIconError("The ICO directory runs past the file.");
	return Array.from({ length: count }, (_, index) => {
		const at = 6 + index * 16;
		const size = bytes.readUInt32LE(at + 8);
		const offset = bytes.readUInt32LE(at + 12);
		if (size === 0 || offset + size > bytes.length) throw new NotAnIconError("An ICO image runs past the file.");
		return { width: bytes[at] || 256, height: bytes[at + 1] || 256, bitCount: bytes.readUInt16LE(at + 6), data: bytes.subarray(offset, offset + size) };
	});
}

/**
 * One BMP image of an ICO file as RGBA pixels: 32-bit with alpha, 24-bit, or
 * 8/4/1-bit with a palette, transparent where its AND mask says so (and
 * where a 32-bit image without any alpha has its mask set).
 */
export function decodeIcoBitmap(dib: Buffer): { data: Buffer; width: number; height: number } {
	if (dib.length < 40 || dib.readUInt32LE(0) < 40) throw new NotAnIconError("The ICO bitmap has no BITMAPINFOHEADER.");
	const headerSize = dib.readUInt32LE(0);
	const width = dib.readInt32LE(4);
	const height = Math.abs(dib.readInt32LE(8)) / 2;
	const bitCount = dib.readUInt16LE(14);
	const compression = dib.readUInt32LE(16);
	if (width <= 0 || width > 256 || height <= 0 || height > 256 || !Number.isInteger(height)) throw new NotAnIconError("The ICO bitmap has an impossible size.");
	if (compression !== 0 && !(compression === 3 && bitCount === 32)) throw new NotAnIconError("The ICO bitmap is compressed.");
	if (![1, 4, 8, 24, 32].includes(bitCount)) throw new NotAnIconError(`The ICO bitmap has ${bitCount} bits per pixel.`);
	const paletteSize = bitCount <= 8 ? (dib.readUInt32LE(32) || 1 << bitCount) : 0;
	const paletteAt = headerSize + (compression === 3 ? 12 : 0);
	const pixelsAt = paletteAt + paletteSize * 4;
	const stride = Math.ceil((width * bitCount) / 32) * 4;
	const maskAt = pixelsAt + stride * height;
	const maskStride = Math.ceil(width / 32) * 4;
	const hasMask = maskAt + maskStride * height <= dib.length;
	if (maskAt > dib.length) throw new NotAnIconError("The ICO bitmap's pixels run past its data.");
	const data = Buffer.alloc(width * height * 4);
	let anyAlpha = false;
	for (let y = 0; y < height; y++) {
		const row = pixelsAt + (height - 1 - y) * stride;
		for (let x = 0; x < width; x++) {
			const out = (y * width + x) * 4;
			if (bitCount >= 24) {
				const at = row + x * (bitCount / 8);
				data[out] = dib[at + 2]!;
				data[out + 1] = dib[at + 1]!;
				data[out + 2] = dib[at]!;
				data[out + 3] = bitCount === 32 ? dib[at + 3]! : 255;
				if (bitCount === 32 && dib[at + 3]! > 0) anyAlpha = true;
			} else {
				const bit = x * bitCount;
				const index = (dib[row + (bit >> 3)]! >> (8 - bitCount - (bit & 7))) & ((1 << bitCount) - 1);
				const colour = paletteAt + Math.min(index, paletteSize - 1) * 4;
				data[out] = dib[colour + 2]!;
				data[out + 1] = dib[colour + 1]!;
				data[out + 2] = dib[colour]!;
				data[out + 3] = 255;
			}
		}
	}
	if (hasMask && !(bitCount === 32 && anyAlpha)) {
		for (let y = 0; y < height; y++) {
			const row = maskAt + (height - 1 - y) * maskStride;
			for (let x = 0; x < width; x++) {
				if ((dib[row + (x >> 3)]! >> (7 - (x & 7))) & 1) data[(y * width + x) * 4 + 3] = 0;
			}
		}
	}
	return { data, width, height };
}

/** The ICO image nearest `ICON_EDGE`, a larger one before a smaller, the deeper colour on a tie. */
function bestIcoEntry(entries: readonly IcoEntry[]): IcoEntry {
	const score = (entry: IcoEntry) => Math.abs(entry.width - ICON_EDGE) + (entry.width < ICON_EDGE ? 0.5 : 0);
	return [...entries].sort((a, b) => score(a) - score(b) || b.bitCount - a.bitCount)[0]!;
}

/** What sharp reads: the file itself, or for an ICO its best image. */
function sharpInput(bytes: Buffer, format: IconFormat): Sharp {
	const options = { limitInputPixels: MAX_SOURCE_PIXELS, failOn: "error" as const };
	if (format !== "ico") return sharp(bytes, { ...options, ...(format === "svg" ? { density: 144 } : {}) });
	const entry = bestIcoEntry(icoEntries(bytes));
	if (sniffIcon(entry.data) === "png") return sharp(entry.data, options);
	const { data, width, height } = decodeIcoBitmap(entry.data);
	return sharp(data, { raw: { width, height, channels: 4 }, ...options });
}

/**
 * A favicon as the pages show it: decoded and drawn again as a
 * `ICON_EDGE`-pixel square PNG, the image centred on transparency. Nothing
 * of the original file is kept, so an SVG's scripts, a polyglot's HTML or a
 * file's metadata never reach our origin. Throws `NotAnIconError` for
 * anything that is not an image, is too big, or is too small to be an icon.
 */
export async function normalizeIcon(bytes: Buffer): Promise<Buffer> {
	if (bytes.length > MAX_ICON_BYTES) throw new NotAnIconError(`The icon is ${bytes.length} bytes, more than ${MAX_ICON_BYTES}.`);
	const format = sniffIcon(bytes);
	if (!format) throw new NotAnIconError("The file is not an image.");
	try {
		const image = sharpInput(bytes, format);
		const { width = 0, height = 0 } = await image.metadata();
		if (format !== "svg" && Math.max(width, height) < MIN_SOURCE_EDGE) throw new NotAnIconError(`The image is ${width}×${height} pixels, too small for an icon.`);
		return await image
			.resize(ICON_EDGE, ICON_EDGE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
			.png({ compressionLevel: 9 })
			.toBuffer();
	} catch (error) {
		if (error instanceof NotAnIconError) throw error;
		throw new NotAnIconError(`The ${format} image does not decode: ${error instanceof Error ? error.message : String(error)}`);
	}
}
