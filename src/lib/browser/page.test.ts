import { expect, test } from "bun:test";
import type { Browser, BrowserContext, Page } from "rebrowser-puppeteer-core";

import { getBrowserPage } from "./page";

test("getBrowserPage leaves Puppeteer's native navigation lifecycle untouched", async () => {
	const goto = async () => null;
	const context = {} as BrowserContext;
	const browser = { defaultBrowserContext: () => context } as unknown as Browser;
	const handlers = new Map<string, (...args: unknown[]) => void>();
	const page = {
		browser: () => browser,
		browserContext: () => context,
		setViewport: async () => undefined,
		on: (event: string, listener: (...args: unknown[]) => void) => { handlers.set(event, listener); },
		goto,
	} as unknown as Page;

	const result = await getBrowserPage(page);

	expect(result.page).toBe(page);
	expect(result.page.goto).toBe(goto);
	expect([...handlers.keys()].sort()).toEqual(["console", "dialog"]);
});
