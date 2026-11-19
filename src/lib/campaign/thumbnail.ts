import sharp from "sharp";

/** Width of the stored preview; the gallery shows it at up to 360 px, twice that for sharp screens. */
const THUMBNAIL_WIDTH = 720;
/** A page whose content is narrower than this after trimming keeps the whole capture. */
const MIN_CONTENT_WIDTH = 240;
/** A capture whose every channel varies less than this is one flat colour; a single line of text on it varies more. */
const BLANK_MAX_STDEV = 2;

/** Whether a capture shows nothing a visitor could recognize: one flat colour, as a page that never rendered leaves it. */
export async function isBlankCapture(screenshot: Buffer): Promise<boolean> {
	const { channels } = await sharp(screenshot).stats();
	return channels.every((channel) => channel.stdev < BLANK_MAX_STDEV);
}

/**
 * Cut a page capture to what the page drew. Kits often draw a narrow card
 * on a wide, empty viewport (white to the right, a tinted margin around the
 * card), so the white is trimmed first and the tinted edge second; each
 * trim only removes edges that are one flat color. The result is a WebP
 * preview, top-aligned when the page is taller than wide.
 */
export async function pageThumbnail(screenshot: Buffer): Promise<Buffer> {
	let image = screenshot;
	for (const options of [{ background: "#ffffff", threshold: 12 }, { threshold: 12 }]) {
		try {
			const { data, info } = await sharp(image).trim(options).png().toBuffer({ resolveWithObject: true });
			if (info.width >= MIN_CONTENT_WIDTH) image = data;
		} catch {
			// A capture of one flat color has nothing to trim to; keep it whole.
		}
	}
	return sharp(image).resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
}
