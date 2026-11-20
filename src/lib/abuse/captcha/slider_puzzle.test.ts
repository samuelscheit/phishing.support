import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import sharp from "sharp";

import { findPuzzleGap } from "./slider_puzzle";

const DIR = `${import.meta.dir}/fixtures/tencent_slider`;
const puzzles = JSON.parse(readFileSync(`${DIR}/expected.json`, "utf8")) as Array<{ name: string; origin: { x: number; y: number }; offset: number }>;
const load = (name: string, part: "background" | "piece") => readFileSync(`${DIR}/${name}_${part}.png`);

describe("slide puzzle gap detection on real Tencent puzzles", () => {
	for (const puzzle of puzzles) {
		test(`puzzle ${puzzle.name}: the gap is found, clearly`, async () => {
			const gap = await findPuzzleGap({ background: load(puzzle.name, "background"), piece: load(puzzle.name, "piece") }, puzzle.origin);
			expect(gap.offset).toBe(puzzle.offset);
			expect(gap.margin).toBeGreaterThan(0.1);
		});
	}

	test("a recompressed, slightly shifted-brightness background still gives the same gap", async () => {
		const puzzle = puzzles[0]!;
		const worn = await sharp(load(puzzle.name, "background")).modulate({ brightness: 1.15 }).jpeg({ quality: 55 }).toBuffer();
		const gap = await findPuzzleGap({ background: worn, piece: load(puzzle.name, "piece") }, puzzle.origin);
		expect(Math.abs(gap.offset - puzzle.offset)).toBeLessThanOrEqual(1);
	});

	test("a background with no gap has no confident answer", async () => {
		const puzzle = puzzles[0]!;
		const { width, height } = await sharp(load(puzzle.name, "background")).metadata();
		const flat = await sharp({ create: { width: width!, height: height!, channels: 3, background: "#667" } }).png().toBuffer();
		const gap = await findPuzzleGap({ background: flat, piece: load(puzzle.name, "piece") }, puzzle.origin);
		expect(gap.margin).toBeLessThan(0.05);
	});

	test("a piece without solid pixels or off the background is refused", async () => {
		const puzzle = puzzles[0]!;
		const clear = await sharp({ create: { width: 136, height: 136, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
		await expect(findPuzzleGap({ background: load(puzzle.name, "background"), piece: clear }, puzzle.origin)).rejects.toThrow("no solid pixels");
		await expect(findPuzzleGap({ background: load(puzzle.name, "background"), piece: load(puzzle.name, "piece") }, { x: puzzle.origin.x, y: 380 })).rejects.toThrow("does not fit");
	});
});
