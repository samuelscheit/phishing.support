import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "rebrowser-puppeteer-core";

import { chromiumAvailable, launchTestChromium } from "@/lib/browser/task/test_helpers";
import { scrollToEnd } from "./scrollToEnd";

// A tall page with a short log box in its middle, as a finished case page lays out its visit log.
const PAGE = `<!doctype html><body style="margin:0">
<div style="height:1500px">top of the case</div>
<div id="outer" style="max-height:200px;overflow-y:auto">
	<ol id="log" style="max-height:100px;overflow-y:auto;margin:0">${Array.from({ length: 40 }, (_, i) => `<li style="height:20px">step ${i}</li>`).join("")}</ol>
</div>
<div id="short" style="max-height:300px;overflow-y:auto"><p>one line</p><span id="end"></span></div>
<div style="height:1500px">bottom of the case</div>
</body>`;

describe.skipIf(!chromiumAvailable)("scrollToEnd in real Chrome", () => {
	let browser: Browser;
	let page: Page;
	beforeAll(async () => {
		browser = await launchTestChromium();
		page = await browser.newPage();
	});
	afterAll(async () => {
		await browser?.close();
	});

	const run = (selector: string) => page.evaluate(`(${scrollToEnd.toString()})(document.querySelector(${JSON.stringify(selector)}))`);
	const state = () => page.evaluate(() => ({
		page: document.scrollingElement!.scrollTop,
		log: document.getElementById("log")!.scrollTop,
		logEnd: document.getElementById("log")!.scrollHeight - document.getElementById("log")!.clientHeight,
		outer: document.getElementById("outer")!.scrollTop,
	}));

	test("follows the newest line of its own box and never moves the page", async () => {
		await page.setContent(PAGE);
		await run("#log li:last-child");
		const after = await state();
		expect(after.page).toBe(0);
		expect(after.log).toBe(after.logEnd);
		// Only the nearest scrolling box moves, not one further out.
		expect(after.outer).toBe(0);
	});

	test("a box with nothing to scroll leaves every box and the page where they are", async () => {
		await page.setContent(PAGE);
		await run("#end");
		expect(await state()).toMatchObject({ page: 0, log: 0, outer: 0 });
	});

	test("an element outside any scrolling box, or none at all, changes nothing", async () => {
		await page.setContent(PAGE);
		await page.evaluate(`(${scrollToEnd.toString()})(document.body.lastElementChild)`);
		await page.evaluate(`(${scrollToEnd.toString()})(null)`);
		expect((await state()).page).toBe(0);
	});
});
