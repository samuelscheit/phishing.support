import type { Page } from "rebrowser-puppeteer-core";

/** One mouse step of a drag: where the pointer goes, relative to where it was pressed, and how long it takes. */
export type SliderStep = { dx: number; dy: number; delayMs: number };

/** Uniform random numbers in [0, 1); injectable so a track can be reproduced. */
export type RandomSource = () => number;

const STEPS = { min: 38, max: 56 };
const STEP_DELAY_MS = { min: 10, max: 34 };
const VERTICAL_DRIFT_PX = 2.5;

/**
 * A drag the way a hand makes it: fast off the start, slowing into the end
 * (ease-out), drifting a little up or down and back, with uneven step
 * times. A behavioural slider such as GNAME's (`/request/slideverify`)
 * scores the recorded track; a straight constant-speed line is a bot's.
 */
export function sliderTrack(distance: number, random: RandomSource = Math.random): SliderStep[] {
	if (!Number.isFinite(distance) || distance <= 0) throw new Error("A slider track needs a positive distance.");
	const count = STEPS.min + Math.floor(random() * (STEPS.max - STEPS.min + 1));
	const drift = (random() * 2 - 1) * VERTICAL_DRIFT_PX;
	const steps: SliderStep[] = [];
	for (let index = 1; index <= count; index++) {
		const t = index / count;
		const eased = 1 - (1 - t) ** 3;
		const jitter = index === count ? 0 : (random() - 0.5) * 0.8;
		steps.push({
			dx: Math.min(distance, Math.max(0, distance * eased + jitter)),
			dy: drift * Math.sin(t * Math.PI) + (random() - 0.5) * 0.6,
			delayMs: Math.round(STEP_DELAY_MS.min + random() * (STEP_DELAY_MS.max - STEP_DELAY_MS.min)),
		});
	}
	// Positions never step back: a pointer that jitters backwards is a replayed curve, not a hand.
	for (let index = 1; index < steps.length; index++) steps[index]!.dx = Math.max(steps[index]!.dx, steps[index - 1]!.dx);
	steps[steps.length - 1]!.dx = distance;
	return steps;
}

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Drag a slider's handle to the far end of its rail with a human track:
 * approach the handle, press somewhere on it, drag, hold, release.
 */
export async function dragSliderToEnd(page: Page, selectors: { handle: string; rail: string }, random: RandomSource = Math.random): Promise<void> {
	const handle = await page.waitForSelector(selectors.handle, { visible: true, timeout: 20_000 });
	if (!handle) throw new Error(`The slider handle ${selectors.handle} never appeared.`);
	// The widget animates in; a box read mid-animation lands the press beside it.
	await pause(800 + random() * 600);
	const handleBox = await handle.boundingBox();
	// The rail that holds this handle: a page may keep other, hidden sliders.
	const railBox = await handle.evaluate((element, rail) => {
		const box = element.closest(rail)?.getBoundingClientRect();
		return box ? { x: box.x, width: box.width } : undefined;
	}, selectors.rail);
	if (!handleBox) throw new Error("The slider handle has no box to press.");
	if (!railBox) throw new Error(`The slider handle is not inside a rail ${selectors.rail}.`);
	const startX = handleBox.x + handleBox.width * (0.35 + random() * 0.3);
	const startY = handleBox.y + handleBox.height * (0.35 + random() * 0.3);
	// Past the end by a few pixels: the widget clamps it, and a hand overshoots.
	const distance = railBox.x + railBox.width - (handleBox.x + handleBox.width) + 3 + random() * 4;

	await page.mouse.move(startX - 30 - random() * 40, startY + 20 + random() * 30, { steps: 6 });
	await page.mouse.move(startX, startY, { steps: 10 + Math.floor(random() * 6) });
	await pause(180 + random() * 220);
	await page.mouse.down();
	for (const step of sliderTrack(distance, random)) {
		await page.mouse.move(startX + step.dx, startY + step.dy);
		await pause(step.delayMs);
	}
	await pause(150 + random() * 200);
	await page.mouse.up();
}
