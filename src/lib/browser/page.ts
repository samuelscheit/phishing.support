import type {
	Browser,
	BrowserContext,
	GoToOptions,
	HTTPResponse,
	Page,
	PuppeteerLifeCycleEvent,
} from "rebrowser-puppeteer-core";

import { sleep } from "../utils";
import { getBrowser } from "./browser";

/**
 * Set up a page attached to a Fabric lease.
 *
 * The browser's default context is the lease's managed profile/ephemeral clone.
 * Do not manufacture an application-owned incognito context and do not perform
 * local CAPTCHA clicking here: Fabric's process-level guardian owns that work.
 */
export async function getBrowserPage(existingPage?: Page) {
	const browser = (existingPage ? existingPage.browser() : await getBrowser()) as Browser;
	const context = (existingPage ? existingPage.browserContext() : browser.defaultBrowserContext()) as BrowserContext;
	const page = existingPage || (await context.newPage());

	page.on("console", (msg) => {
		console.log(`[Browser Console] [${msg.type()}] ${msg.text()}`);
	});

	page.on("dialog", async (dialog) => {
		await sleep(1000 * Math.random() + 1000);
		await dialog.dismiss();
	});
	await page.setViewport({ width: 1920, height: 1080 });

	const originalGoto = page.goto.bind(page);
	async function handleResponse(response: HTTPResponse | null, waitUntil?: string, timeout = 30_000) {
		if (waitUntil === "networkidle0") {
			await page.waitForNetworkIdle({ concurrency: 0, idleTime: 500, timeout });
		} else if (waitUntil === "networkidle2") {
			await page.waitForNetworkIdle({ concurrency: 2, idleTime: 500, timeout });
		} else if (waitUntil === "load") {
			const start = Date.now();
			while (true) {
				try {
					if ((await page.evaluate(() => document.readyState)) === "complete") break;
				} catch {}
				if (Date.now() - start > timeout) throw new Error("Timeout waiting for load event");
				await sleep(50);
			}
		} else if (waitUntil === "domcontentloaded") {
			const start = Date.now();
			while (true) {
				try {
					const readyState = await page.evaluate(() => document.readyState);
					if (readyState === "interactive" || readyState === "complete") break;
				} catch {}
				if (Date.now() - start > timeout) throw new Error("Timeout waiting for domcontentloaded event");
				await sleep(50);
			}
		}

		return response;
	}

	page.goto = async (url: string, options?: GoToOptions) => {
		const response = await originalGoto(url, { ...options, waitUntil: "domcontentloaded" });
		return handleResponse(response, (options?.waitUntil as PuppeteerLifeCycleEvent) || "load", options?.timeout || 30_000);
	};

	return { page, context, browser };
}
