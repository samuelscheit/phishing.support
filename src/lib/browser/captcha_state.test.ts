import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Browser, Page } from "rebrowser-puppeteer-core";

import { OperationCanceledError } from "../abuse/worker/cancellation";
import { CaptchaError, waitForCaptchaOutcome, waitForCaptchaToken } from "./captcha_state";
import { chromiumAvailable, html, launchTestChromium } from "./task/test_helpers";

/** Plays the solver: sets the top document's captcha state at the given times (ms after load), with its window event. */
const solver = (steps: Array<[ms: number, state: string, detail?: string]>, extra = "") => `<script>
window.setCaptcha = (state, detail) => {
	if (detail) document.documentElement.setAttribute("data-captcha-detail", detail);
	document.documentElement.setAttribute("data-captcha-state", state);
	window.dispatchEvent(new CustomEvent("captcha-state", { detail: { state, detail } }));
};
for (const [ms, state, detail] of ${JSON.stringify(steps)}) setTimeout(() => window.setCaptcha(state, detail), ms);
${extra}
</script>`;

const PAGES: Record<string, string> = {
	// The solver's writes come well after load, so the wait's first look (its baseline) precedes them even on a busy machine.
	"/solved": solver([[600, "solving", "tcaptcha"], [1_000, "solved", "tcaptcha"]]),
	"/none": "<p>No challenge here.</p>",
	"/failed": solver([[600, "solving", "recaptcha"], [800, "failed", "recaptcha: image grid not solved"]]),
	"/stuck": solver([[50, "solving", "tcaptcha"]]),
	// The widget fills its field while the solver still works on it: only the solved state releases the token.
	"/recaptcha": `<div class="g-recaptcha"><textarea name="g-recaptcha-response" style="display:none"></textarea></div>${solver([[600, "solving", "recaptcha"], [800, "solving", "recaptcha"], [1_200, "solved", "recaptcha"]], `
setTimeout(() => { document.querySelector("textarea").value = "03AF-partial"; }, 800);
setTimeout(() => { document.querySelector("textarea").value = "03AF-token"; }, 1_150);`)}`,
	// Turnstile passes invisibly: a token and never a state.
	"/turnstile": `<div style="height:3000px"></div><div class="cf-turnstile"><input type="hidden" name="cf-turnstile-response" value=""></div>
<script>new IntersectionObserver((entries, observer) => { if (entries[0].isIntersecting) { setTimeout(() => { document.querySelector("[name=cf-turnstile-response]").value = "0.turnstile"; }, 200); observer.disconnect(); } }).observe(document.querySelector(".cf-turnstile"));</script>`,
	"/empty-widget": `<div class="cf-turnstile"><input type="hidden" name="cf-turnstile-response" value=""></div>`,
	// The challenge navigates to the page it guarded.
	"/navigates": `<script>setTimeout(() => { location.href = "/solved"; }, 200);</script>`,
	// One document, two challenges: the first already over when the test's wait begins.
	"/earlier": `<textarea name="g-recaptcha-response"></textarea>${solver([[0, "failed", "tcaptcha: earlier challenge"]])}`,
	// A modal dialog: every evaluate on the page hangs until it is closed.
	"/dialog": `<script>setTimeout(() => alert("Session expired"), 100);</script>`,
};

describe.skipIf(!chromiumAvailable)("the solver's captcha state on a real page", () => {
	let server: ReturnType<typeof Bun.serve>;
	let browser: Browser;
	let page: Page;
	beforeAll(() => {
		server = Bun.serve({ port: 0, fetch: (request) => {
			const body = PAGES[new URL(request.url).pathname];
			return body === undefined ? new Response("not found", { status: 404 }) : html(body);
		} });
	});
	// A browser per test: one test's crashed or closing tab never takes the next one with it.
	beforeEach(async () => {
		browser = await launchTestChromium();
		page = await browser.newPage();
	});
	afterEach(async () => { await browser.close(); });
	afterAll(() => { server?.stop(true); });
	const open = (path: string) => page.goto(`http://127.0.0.1:${server.port}${path}`, { waitUntil: "domcontentloaded" });
	const options = { label: "The test captcha", timeoutMs: 5_000, pollMs: 50 };
	const solved = () => page.evaluate(() => document.documentElement.getAttribute("data-captcha-state") === "solved");

	test("an outcome wait carries on through solving and ends once the outcome holds", async () => {
		await open("/solved");
		const started = Date.now();
		await waitForCaptchaOutcome(page, solved, options);
		expect(Date.now() - started).toBeGreaterThanOrEqual(400);
	});

	test("with no captcha at all an outcome wait is a plain bounded wait", async () => {
		await open("/none");
		let looks = 0;
		await waitForCaptchaOutcome(page, () => ++looks === 3, options);
		await expect(waitForCaptchaOutcome(page, () => false, { ...options, timeoutMs: 300 })).rejects.toThrow("The test captcha: not done within 0 s (no captcha state)");
	});

	test("a failed solve throws at once with the solver's reason", async () => {
		await open("/failed");
		const started = Date.now();
		const error = await waitForCaptchaOutcome(page, () => false, options).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(CaptchaError);
		expect(error).toMatchObject({ state: "failed", detail: "recaptcha: image grid not solved", message: "The test captcha: the captcha solver failed (recaptcha: image grid not solved)" });
		expect(Date.now() - started).toBeLessThan(3_000);
	});

	test("still solving at the deadline throws, naming the state and the adapter", async () => {
		await open("/stuck");
		await expect(waitForCaptchaOutcome(page, () => false, { ...options, timeoutMs: 600 })).rejects.toThrow("The test captcha: not done within 1 s (solving: tcaptcha)");
	});

	test("an aborted signal ends the wait as a cancellation", async () => {
		await open("/stuck");
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		await expect(waitForCaptchaOutcome(page, () => false, { ...options, signal: controller.signal })).rejects.toBeInstanceOf(OperationCanceledError);
	});

	test("a navigation during the wait is looked through, to the next page's state", async () => {
		await open("/navigates");
		await waitForCaptchaOutcome(page, () => solved().catch(() => false), options);
		expect(page.url()).toEndWith("/solved");
	});

	test("a failed verdict an earlier challenge left on the document does not end a later wait", async () => {
		await open("/earlier");
		await page.waitForFunction(() => document.documentElement.getAttribute("data-captcha-state") === "failed");
		let looks = 0;
		await waitForCaptchaOutcome(page, () => ++looks === 4, options);
		await expect(waitForCaptchaOutcome(page, () => false, { ...options, timeoutMs: 300 }))
			.rejects.toThrow("The test captcha: not done within 0 s (no captcha state; before this wait: failed: tcaptcha: earlier challenge)");
	});

	test("the next challenge on the same document is followed: its own failed verdict ends the wait, even with the same detail", async () => {
		await open("/earlier");
		await page.waitForFunction(() => document.documentElement.getAttribute("data-captcha-state") === "failed");
		// The solver fails the next challenge with the very same words: only the write itself tells it apart.
		setTimeout(() => void page.evaluate(() => (window as unknown as { setCaptcha(state: string, detail: string): void }).setCaptcha("failed", "tcaptcha: earlier challenge")), 300);
		const started = Date.now();
		await expect(waitForCaptchaOutcome(page, () => false, options)).rejects.toMatchObject({ state: "failed", message: "The test captcha: the captcha solver failed (tcaptcha: earlier challenge)" });
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	test("an earlier solved verdict hands out no token: the next challenge's is waited for", async () => {
		await open("/earlier");
		await page.evaluate(() => (window as unknown as { setCaptcha(state: string, detail: string): void }).setCaptcha("solved", "recaptcha"));
		await page.evaluate(() => { document.querySelector("textarea")!.value = ""; });
		setTimeout(() => void page.evaluate(() => {
			const scoped = window as unknown as { setCaptcha(state: string, detail: string): void };
			scoped.setCaptcha("solving", "recaptcha");
			setTimeout(() => { document.querySelector("textarea")!.value = "03AF-second"; scoped.setCaptcha("solved", "recaptcha"); }, 300);
		}), 300);
		expect(await waitForCaptchaToken(page, "recaptcha", options)).toBe("03AF-second");
	});

	test("a page that stops answering (a modal dialog) cannot hold the wait past its deadline", async () => {
		await open("/dialog");
		await new Promise((resolve) => setTimeout(resolve, 300));
		const started = Date.now();
		await expect(waitForCaptchaOutcome(page, () => false, { ...options, timeoutMs: 1_000 })).rejects.toBeInstanceOf(CaptchaError);
		expect(Date.now() - started).toBeLessThan(2_500);
	});

	const setCaptcha = (state: string, detail: string) => page.evaluate((s, d) => (window as unknown as { setCaptcha(state: string, detail: string): void }).setCaptcha(s, d), state, detail);
	const IMAGES_FAILED = "recaptcha-images: not solved in 8 rounds";

	test("Fabric's token fallback after the image rounds reads as solving, and its bought token ends the wait", async () => {
		await open("/earlier");
		await page.evaluate(() => { document.querySelector("textarea")!.value = ""; });
		setTimeout(async () => {
			await setCaptcha("solving", "recaptcha-checkbox");
			// The image rounds are over; Fabric buys a token, and the page says so.
			setTimeout(async () => {
				await setCaptcha("solving", "recaptcha: token fallback");
				setTimeout(async () => {
					await page.evaluate(() => { document.querySelector("textarea")!.value = "03AF-bought"; });
					await setCaptcha("solved", "recaptcha: token");
				}, 1_200);
			}, 600);
		}, 400);
		expect(await waitForCaptchaToken(page, "recaptcha", options)).toBe("03AF-bought");
	});

	test("a reCAPTCHA failed after the image rounds is final: the wait ends at once with its reason", async () => {
		await open("/earlier");
		setTimeout(() => void setCaptcha("failed", IMAGES_FAILED), 400);
		const started = Date.now();
		await expect(waitForCaptchaToken(page, "recaptcha", options)).rejects.toMatchObject({ state: "failed", detail: IMAGES_FAILED });
		expect(Date.now() - started).toBeLessThan(2_500);
	});

	test("a reCAPTCHA token is read only once the solver says solved", async () => {
		await open("/recaptcha");
		expect(await waitForCaptchaToken(page, "recaptcha", options)).toBe("03AF-token");
	});

	test("a Turnstile that passes by itself once scrolled into view gives its token without any state", async () => {
		await open("/turnstile");
		expect(await waitForCaptchaToken(page, "turnstile", { ...options, widgetSelector: ".cf-turnstile" })).toBe("0.turnstile");
	});

	test("a widget that gives no token is named as such", async () => {
		await open("/empty-widget");
		await expect(waitForCaptchaToken(page, "turnstile", { ...options, timeoutMs: 300, widgetSelector: ".cf-turnstile" }))
			.rejects.toThrow("The test captcha: no token within 0 s (no captcha state)");
	});

	test("a page without the widget is told apart from one whose widget gave no token", async () => {
		await open("/none");
		await expect(waitForCaptchaToken(page, "turnstile", { ...options, timeoutMs: 300, widgetSelector: ".cf-turnstile" }))
			.rejects.toThrow("The test captcha: the widget (.cf-turnstile) is not on the page");
	});

	test("a failed solve ends the token wait too", async () => {
		await open("/failed");
		await expect(waitForCaptchaToken(page, "recaptcha", options)).rejects.toMatchObject({ state: "failed", detail: "recaptcha: image grid not solved" });
	});
});
