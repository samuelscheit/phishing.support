import type { Browser, BrowserContext, Page } from "rebrowser-puppeteer-core";

import { sleep } from "../utils";
import { getBrowser } from "./browser";

/**
 * A desktop browser as a visitor has it: a 1920×1080 screen, a window below
 * the menu bar, and the page below the window's own tab and address bar.
 * Cloakers compare these: a headless default (an 800×600 screen holding a
 * page larger than its window) is answered with a decoy, and so is a window no
 * taller than the page it shows (production case 375199039110516736).
 */
const DESKTOP_SCREEN = { width: 1920, height: 1080 } as const;
const DESKTOP_WINDOW = { left: 0, top: 25, width: 1920, height: 1050 } as const;
const BROWSER_TOOLBAR_HEIGHT = 87;

/** The metrics override lives as long as the CDP session that set it, so the session stays attached to the page. */
async function useDesktopWindow(page: Page) {
	const cdp = await page.createCDPSession();
	const { windowId } = await cdp.send("Browser.getWindowForTarget");
	await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal", ...DESKTOP_WINDOW } });
	await cdp.send("Emulation.setDeviceMetricsOverride", {
		width: DESKTOP_WINDOW.width,
		height: DESKTOP_WINDOW.height - BROWSER_TOOLBAR_HEIGHT,
		deviceScaleFactor: 1,
		mobile: false,
		screenWidth: DESKTOP_SCREEN.width,
		screenHeight: DESKTOP_SCREEN.height,
	});
}

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
	await useDesktopWindow(page);

	return { page, context, browser };
}
