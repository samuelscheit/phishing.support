import type { Browser, BrowserContext, Page } from "rebrowser-puppeteer-core";

import { sleep } from "../utils";
import { getBrowser } from "./browser";

/** Set up a page attached to a Fabric-owned browser lease. */
export async function getBrowserPage(existingPage?: Page) {
	const browser = (existingPage ? existingPage.browser() : await getBrowser()) as Browser;
	const context = (existingPage ? existingPage.browserContext() : browser.defaultBrowserContext()) as BrowserContext;
	const page = existingPage || (await context.newPage());

	page.on("console", (message) => {
		console.log(`[Browser Console] [${message.type()}] ${message.text()}`);
	});

	page.on("dialog", async (dialog) => {
		await sleep(1000 * Math.random() + 1000);
		await dialog.dismiss();
	});
	await page.setViewport({ width: 1920, height: 1080 });

	return { page, context, browser };
}
