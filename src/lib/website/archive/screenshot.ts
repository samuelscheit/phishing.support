import type { Page } from "rebrowser-puppeteer-core";
import sharp from "sharp";

import { errorText } from "../../util/error_text";
import { sleep } from "../../util/sleep";
import { raceTimeout } from "../../util/async";

/** Attempts at a screenshot that shows what the page has rendered. */
const SCREENSHOT_PAINT_ATTEMPTS = 4;

/** Whether a screenshot is one flat colour: no text, no edges, nothing drawn. */
async function isBlankScreenshot(png: Uint8Array): Promise<boolean> {
	const { channels } = await sharp(png).stats();
	return channels.slice(0, 3).every((channel) => channel.stdev < 2);
}

/**
 * A page that cannot be pictured: Chromium refuses a document with no
 * laid-out content ("Cannot take screenshot with 0 width"), or never answers
 * for one that stopped producing frames (a redirect script whose target
 * answered 204 No Content, production case 380167497774534682: full-page,
 * viewport and raw CDP screenshots all hung while its layout was 1920×963).
 * That is the page, not a broken browser: it is captured without a
 * screenshot, and its MHTML and text remain the evidence.
 */
const UNPICTURABLE_PAGE = /Cannot take screenshot with 0 (?:width|height)/i;
/** How long one screenshot may take before the page counts as one that cannot be pictured. */
const SCREENSHOT_TIMEOUT_MS = 20_000;

class ScreenshotTimeoutError extends Error {}

/**
 * A full-page screenshot of what the page shows. Headless Chromium sometimes
 * returns a frame it has not painted yet, a blank page over a document full of
 * text (a Google Site captured right after its embedded kit navigated). When
 * the document shows text but the image is blank, wait for the next frames to
 * paint and capture again; a page that is truly empty stays blank.
 */
export async function capturePaintedScreenshot(page: Page, timeoutMs = SCREENSHOT_TIMEOUT_MS): Promise<Uint8Array | undefined> {
	const capture = async (): Promise<Uint8Array | undefined> => {
		const shot = page.screenshot({ fullPage: true, captureBeyondViewport: true, type: "png" });
		try {
			return await raceTimeout(shot, timeoutMs, () => new ScreenshotTimeoutError());
		} catch (error) {
			if (error instanceof ScreenshotTimeoutError) {
				// The hung call may still settle later; nobody is waiting for it.
				void shot.catch(() => undefined);
				console.warn(`Screenshot of ${page.url()} did not answer within ${timeoutMs / 1000}s; captured without one.`);
				return undefined;
			}
			if (UNPICTURABLE_PAGE.test(errorText(error))) {
				console.warn(`Screenshot of ${page.url()} refused (${errorText(error)}); captured without one.`);
				return undefined;
			}
			throw error;
		}
	};
	let screenshot = await capture();
	for (let attempt = 1; screenshot && attempt < SCREENSHOT_PAINT_ATTEMPTS && await isBlankScreenshot(screenshot); attempt++) {
		const showsText = await page.evaluate(() => (document.body?.innerText ?? "").trim().length > 0).catch(() => false);
		if (!showsText) break;
		await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))).catch(() => undefined);
		await sleep(500 * attempt);
		screenshot = await capture();
	}
	return screenshot;
}

