import { expect, test } from "bun:test";
import type { Browser, BrowserContext, Page } from "rebrowser-puppeteer-core";

import { getBrowserPage } from "./page";

function fakePage() {
	const goto = async () => null;
	const context = {} as BrowserContext;
	const browser = { defaultBrowserContext: () => context } as unknown as Browser;
	const handlers = new Map<string, (...args: unknown[]) => void>();
	const cdpCalls: Array<{ method: string; params: unknown }> = [];
	let detached = false;
	const page = {
		browser: () => browser,
		browserContext: () => context,
		createCDPSession: async () => ({
			send: async (method: string, params: unknown) => {
				cdpCalls.push({ method, params });
				return method === "Browser.getWindowForTarget" ? { windowId: 7 } : {};
			},
			detach: async () => { detached = true; },
		}),
		on: (event: string, listener: (...args: unknown[]) => void) => { handlers.set(event, listener); },
		goto,
	} as unknown as Page;
	return { page, goto, handlers, cdpCalls, isDetached: () => detached };
}

test("getBrowserPage leaves Puppeteer's native navigation lifecycle untouched", async () => {
	const { page, goto, handlers } = fakePage();

	const result = await getBrowserPage(page);

	expect(result.page).toBe(page);
	expect(result.page.goto).toBe(goto);
	expect([...handlers.keys()].sort()).toEqual(["console", "dialog"]);
});

test("the page sits in a desktop-sized window on a desktop-sized screen, as cloakers expect", async () => {
	// Production 2026-11-01: s-url.sbs answered the headless 800×600 screen with
	// "outerW<innerW", and a window no taller than its page with "headless-pattern".
	const { page, cdpCalls, isDetached } = fakePage();

	await getBrowserPage(page);

	expect(cdpCalls).toEqual([
		{ method: "Browser.getWindowForTarget", params: undefined },
		{ method: "Browser.setWindowBounds", params: { windowId: 7, bounds: { windowState: "normal", left: 0, top: 25, width: 1920, height: 1050 } } },
		{ method: "Emulation.setDeviceMetricsOverride", params: { width: 1920, height: 963, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 } },
	]);
	// Detaching would drop the override.
	expect(isDetached()).toBe(false);
});
