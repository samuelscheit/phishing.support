/**
 * Where a point on the shown screen lands in the page. The screen is drawn
 * `object-contain` and centred in its box: a frame of another shape than the
 * box leaves bars on two sides, which are not the page. Input coordinates
 * are the page's CSS pixels: the frame's `width` × `height`.
 */

export type Box = { left: number; top: number; width: number; height: number };
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };

/** The part of the box the frame covers. */
export function contentBox(box: Box, frame: Size): Box {
	if (box.width <= 0 || box.height <= 0 || frame.width <= 0 || frame.height <= 0) return { left: box.left, top: box.top, width: 0, height: 0 };
	const scale = Math.min(box.width / frame.width, box.height / frame.height);
	const width = frame.width * scale;
	const height = frame.height * scale;
	return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * The page point under a client point, or nothing on the bars or outside.
 * `clamp` pins a point outside to the nearest edge instead: a drag that
 * leaves the screen still ends in the page.
 */
export function toPagePoint(client: Point, box: Box, frame: Size, { clamp = false }: { clamp?: boolean } = {}): Point | undefined {
	const content = contentBox(box, frame);
	if (!content.width || !content.height) return undefined;
	let x = ((client.x - content.left) / content.width) * frame.width;
	let y = ((client.y - content.top) / content.height) * frame.height;
	if (clamp) {
		x = Math.min(frame.width, Math.max(0, x));
		y = Math.min(frame.height, Math.max(0, y));
	} else if (x < 0 || y < 0 || x > frame.width || y > frame.height) {
		return undefined;
	}
	return { x: round(x), y: round(y) };
}

/** Page pixels per shown pixel: a finger's swipe moves the page as far as it moved on the screen. */
export function pageScale(box: Box, frame: Size): number {
	const content = contentBox(box, frame);
	return content.width ? frame.width / content.width : 1;
}

/** Pixels a wheel line is in Chrome. */
const LINE_PX = 40;

/** A wheel event's deltas in pixels, whatever unit it came in (pixels, lines or pages). */
export function wheelPixels(event: { deltaX: number; deltaY: number; deltaMode: number }, page: Size): { deltaX: number; deltaY: number } {
	const unit = event.deltaMode === 1 ? { x: LINE_PX, y: LINE_PX } : event.deltaMode === 2 ? { x: page.width, y: page.height } : { x: 1, y: 1 };
	return { deltaX: round(event.deltaX * unit.x), deltaY: round(event.deltaY * unit.y) };
}
