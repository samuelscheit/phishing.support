import type { Frame, Page } from "patchright";

import { dragBy, type RandomSource } from "../../captcha/slider_drag";
import { findPuzzleGap } from "../../captcha/slider_puzzle";
import { sleep } from "../../../util/sleep";
import { throwIfOperationCanceled } from "../../worker/cancellation";

/** Tencent's TCaptcha slide puzzle, in the popup frame the form opens on submit. */
const CAPTCHA_FRAME = /t\.captcha\.qcloud\.com\/cap_union_new_show/;
const SELECTORS = { background: "#slideBg", piece: "#slideBlock", handle: "#tcaptcha_drag_button", reload: "#reload" } as const;

const SLIDER = {
	/** Drags before the slider is given up on; each follows a fresh puzzle. */
	attempts: 6,
	frameTimeoutMs: 20_000,
	/** How long a released drag may take to either pass or be replaced by a new puzzle. */
	verdictTimeoutMs: 8_000,
	pollMs: 250,
	/** A gap that wins by less than this over its best rival is a guess: take another puzzle. */
	minimumMargin: 0.05,
} as const;

type Puzzle = {
	backgroundUrl: string;
	pieceUrl: string;
	/** Rendered pixels per image pixel. */
	scale: number;
	/** Where the piece image starts on the background, in image pixels. */
	origin: { x: number; y: number };
};

/** Runs inside the captcha frame: no closures. */
function puzzleProbe(selectors: { background: string; piece: string }): Puzzle | undefined {
	const background = document.querySelector(selectors.background) as HTMLImageElement | null;
	const piece = document.querySelector(selectors.piece) as HTMLImageElement | null;
	if (!background?.complete || !piece?.complete || !background.naturalWidth || !piece.naturalWidth) return undefined;
	const backgroundBox = background.getBoundingClientRect();
	const pieceBox = piece.getBoundingClientRect();
	const scale = backgroundBox.width / background.naturalWidth;
	if (!(scale > 0)) return undefined;
	return {
		backgroundUrl: background.src,
		pieceUrl: piece.src,
		scale,
		origin: { x: Math.round((pieceBox.x - backgroundBox.x) / scale), y: Math.round((pieceBox.y - backgroundBox.y) / scale) },
	};
}

/** Runs inside the captcha frame: the images as the widget itself loaded them. */
async function fetchImages(urls: string[]): Promise<string[]> {
	return Promise.all(urls.map(async (url) => {
		const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
		let binary = "";
		for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
		return btoa(binary);
	}));
}

export type TencentSliderOptions = {
	/** True once the form's own request carrying a passed captcha was seen. */
	passed: () => boolean;
	signal?: AbortSignal;
	random?: RandomSource;
};

const captchaFrame = (page: Page): Frame | undefined => page.frames().find((frame) => CAPTCHA_FRAME.test(frame.url()));

async function until(condition: () => Promise<boolean> | boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
	for (const deadline = Date.now() + timeoutMs; ; await sleep(SLIDER.pollMs, signal)) {
		throwIfOperationCanceled(signal, "Tencent slider solving was canceled.");
		if (await Promise.resolve(condition()).catch(() => false)) return true;
		if (Date.now() >= deadline) return false;
	}
}

/**
 * Pass Tencent's slide puzzle on the page: read the background and the piece
 * the widget loaded, locate the gap by image analysis, and drag the handle
 * there with a human track. A refused drag leaves a new puzzle; a puzzle
 * whose gap is ambiguous is replaced rather than guessed. Resolves once
 * `passed()` is true.
 */
export async function solveTencentSlider(page: Page, options: TencentSliderOptions): Promise<void> {
	const { signal, random = Math.random } = options;
	const reasons: string[] = [];
	for (let attempt = 1; attempt <= SLIDER.attempts; attempt++) {
		if (options.passed()) return;
		if (!(await until(() => captchaFrame(page) !== undefined, SLIDER.frameTimeoutMs, signal))) throw new Error("Tencent's slider puzzle never appeared.");
		const frame = captchaFrame(page)!;
		// The widget animates in; a box read mid-animation lands the press beside it.
		await sleep(900 + random() * 500, signal);
		let puzzle: Puzzle | undefined;
		await until(async () => (puzzle = await frame.evaluate(puzzleProbe, SELECTORS)) !== undefined, SLIDER.frameTimeoutMs, signal);
		if (!puzzle) throw new Error("Tencent's slider puzzle images never loaded.");
		const [background, piece] = (await frame.evaluate(fetchImages, [puzzle.backgroundUrl, puzzle.pieceUrl])).map((base64) => Buffer.from(base64, "base64"));
		const gap = await findPuzzleGap({ background: background!, piece: piece! }, puzzle.origin);
		const handleBox = await frame.locator(SELECTORS.handle).first().boundingBox();
		if (!handleBox) throw new Error("Tencent's slider handle has no box to drag.");
		// A refused drag makes the widget load a new puzzle by itself; anything else needs a nudge.
		let replaced = false;
		if (gap.margin < SLIDER.minimumMargin) {
			reasons.push(`ambiguous gap (margin ${gap.margin.toFixed(3)})`);
		} else {
			await dragBy(page.mouse, handleBox, () => gap.offset * puzzle!.scale, random);
			replaced = await until(async () => options.passed() || (await frame.evaluate(puzzleProbe, SELECTORS))?.backgroundUrl !== puzzle!.backgroundUrl, SLIDER.verdictTimeoutMs, signal);
			if (options.passed()) return;
			reasons.push(replaced ? "drag refused" : "no verdict after the drag");
		}
		if (!replaced) await frame.locator(SELECTORS.reload).first().click({ timeout: 5_000 }).catch(() => undefined);
	}
	throw new Error(`Tencent's slider did not pass after ${SLIDER.attempts} puzzles (${reasons.join("; ")}).`);
}
