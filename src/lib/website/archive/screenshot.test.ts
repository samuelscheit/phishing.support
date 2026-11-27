import { describe, expect, test } from "bun:test";
import type { Page } from "rebrowser-puppeteer-core";
import sharp from "sharp";

import { capturePaintedScreenshot } from "./screenshot";

async function nonBlankPng(): Promise<Uint8Array> {
	const box = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#000000" } }).png().toBuffer();
	return sharp({ create: { width: 100, height: 100, channels: 3, background: "#ffffff" } })
		.composite([{ input: box, left: 10, top: 10 }])
		.png()
		.toBuffer();
}

function fakePage(screenshot: (options: { fullPage?: boolean }) => Promise<Uint8Array>): Page {
	return {
		url: () => "https://app.centripe.com/register",
		screenshot: screenshot as Page["screenshot"],
		evaluate: async () => false,
	} as unknown as Page;
}

describe("capturePaintedScreenshot", () => {
	test("falls back to a viewport screenshot when full-page capture fails with Unable to capture screenshot", async () => {
		const png = await nonBlankPng();
		const calls: Array<boolean | undefined> = [];
		const page = fakePage(async (options) => {
			calls.push(options.fullPage);
			if (options.fullPage) throw new Error("Protocol error (Page.captureScreenshot): Unable to capture screenshot");
			return png;
		});
		const captured = await capturePaintedScreenshot(page);
		expect(calls).toEqual([true, false]);
		expect(captured).toEqual(png);
	});

	test("returns undefined when both full-page and viewport fail with Unable to capture screenshot", async () => {
		const calls: Array<boolean | undefined> = [];
		const page = fakePage(async (options) => {
			calls.push(options.fullPage);
			throw new Error("Protocol error (Page.captureScreenshot): Unable to capture screenshot");
		});
		expect(await capturePaintedScreenshot(page)).toBeUndefined();
		expect(calls).toEqual([true, false]);
	});

	test("rethrows real browser disconnect errors instead of swallowing them", async () => {
		const page = fakePage(async () => {
			throw new Error("Protocol error (Page.captureScreenshot): Target closed");
		});
		await expect(capturePaintedScreenshot(page)).rejects.toThrow("Target closed");
	});
});
