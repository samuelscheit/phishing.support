import sharp from "sharp";

/** Where the piece image's top-left corner sits in the background, in the background's own pixels. */
export type PuzzleOrigin = { x: number; y: number };

export type PuzzleGap = {
	/** How far right the piece must move, in background pixels, to sit in its gap. */
	offset: number;
	/** How much better the gap scores than the best place at least a piece-edge away from it (0 to 1); a low value means a guess. */
	margin: number;
};

/** A background and its piece, as the images a slide puzzle serves: the piece has a transparent surround. */
export type PuzzleImages = { background: Buffer; piece: Buffer };

/** Pixels of piece outline: the interior is judged this far inside the edge, the surround this far outside it. */
const EDGE_PX = 3;
const RING_PX = 4;
const ALPHA_SOLID = 128;
/** Keeps a black surround from blowing the contrast up. */
const LUMINANCE_FLOOR = 8;
/** Candidates this close to the best one are the same gap, not a rival. */
const RIVAL_DISTANCE_PX = 12;

type Grey = { width: number; height: number; data: Uint8Array };

async function greyscale(image: Buffer): Promise<Grey> {
	const { data, info } = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true });
	return { width: info.width, height: info.height, data };
}

/** The offsets (into the background, from the piece's corner) of its solid interior and of the ring just outside its outline. */
async function pieceRegions(piece: Buffer, backgroundWidth: number): Promise<{ inside: Int32Array; ring: Int32Array; width: number; solidRight: number }> {
	const { data, info } = await sharp(piece).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const { width, height } = info;
	const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && data[(y * width + x) * 4 + 3]! >= ALPHA_SOLID;
	const within = (x: number, y: number, radius: number, test: (x: number, y: number) => boolean) => {
		for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) if (dx * dx + dy * dy <= radius * radius && test(x + dx, y + dy)) return true;
		return false;
	};
	const inside: number[] = [];
	const ring: number[] = [];
	let solidRight = 0;
	for (let y = -RING_PX; y < height + RING_PX; y++) {
		for (let x = -RING_PX; x < width + RING_PX; x++) {
			if (solid(x, y)) {
				solidRight = Math.max(solidRight, x);
				if (!within(x, y, EDGE_PX, (px, py) => !solid(px, py))) inside.push(y * backgroundWidth + x);
			} else if (within(x, y, RING_PX, solid)) ring.push(y * backgroundWidth + x);
		}
	}
	if (inside.length === 0) throw new Error("The puzzle piece has no solid pixels.");
	return { inside: Int32Array.from(inside), ring: Int32Array.from(ring), width, solidRight };
}

/**
 * Find the gap a piece fits into. The gap is the piece's outline cut into the
 * background and darkened, so at the right offset the pixels inside the
 * outline are clearly darker than the ring just outside it. Every offset to
 * the right of the piece is scored by that contrast. The piece sits on the
 * background at `origin`; the gap lies on the same rows.
 */
export async function findPuzzleGap(images: PuzzleImages, origin: PuzzleOrigin): Promise<PuzzleGap> {
	const background = await greyscale(images.background);
	const { inside, ring, solidRight } = await pieceRegions(images.piece, background.width);
	const rowBase = origin.y * background.width;
	const reach = [...inside, ...ring];
	if (rowBase + Math.min(...reach) < 0 || rowBase + Math.max(...reach) >= background.data.length) throw new Error("The puzzle piece does not fit the background rows.");
	const scores = new Map<number, number>();
	for (let x = origin.x + 1; x + solidRight < background.width; x++) {
		let innerSum = 0;
		let ringSum = 0;
		for (const index of inside) innerSum += background.data[rowBase + x + index]!;
		for (const index of ring) ringSum += background.data[rowBase + x + index]!;
		const innerMean = innerSum / inside.length;
		const ringMean = ringSum / ring.length;
		scores.set(x, (ringMean - innerMean) / (ringMean + LUMINANCE_FLOOR));
	}
	let best: { x: number; score: number } | undefined;
	for (const [x, score] of scores) if (!best || score > best.score) best = { x, score };
	if (!best) throw new Error("The puzzle background has no room right of the piece.");
	let rival = 0;
	for (const [x, score] of scores) if (Math.abs(x - best.x) > RIVAL_DISTANCE_PX && score > rival) rival = score;
	return { offset: best.x - origin.x, margin: Math.max(0, best.score - rival) };
}
