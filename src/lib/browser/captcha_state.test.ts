import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Browser, Page } from "rebrowser-puppeteer-core";

import { OperationCanceledError } from "../abuse/worker/cancellation";
import { CaptchaError, waitForCaptchaSolved, waitForCaptchaToken } from "./captcha_state";
import { chromiumAvailable, html, launchTestChromium } from "./task/test_helpers";

/** Plays the solver: sets the top document's captcha state at the given times (ms after load). */
const solver = (steps: Array<[ms: number, state: string, detail?: string]>, extra = "") => `<script>
for (const [ms, state, detail] of ${JSON.stringify(steps)}) setTimeout(() => {
	document.documentElement.setAttribute("data-captcha-state", state);
	if (detail) document.documentElement.setAttribute("data-captcha-detail", detail);
}, ms);
${extra}
</script>`;

const PAGES: Record<string, string> = {
	"/solved": solver([[100, "solving", "tcaptcha"], [500, "solved", "tcaptcha"]]),
	"/none": "<p>No challenge here.</p>",
	"/failed": solver([[100, "solving", "recaptcha"], [300, "failed", "recaptcha: image grid not solved"]]),
	"/stuck": solver([[50, "solving", "tcaptcha"]]),
	"/late": solver([[1_500, "solving", "gname"], [1_800, "solved", "gname"]]),
	// The widget fills its field while the solver still works on it: only the solved state releases the token.
	"/recaptcha": `<div class="g-recaptcha"><textarea name="g-recaptcha-response" style="display:none"></textarea></div>${solver([[100, "solving", "recaptcha"], [300, "solving", "recaptcha"], [700, "solved", "recaptcha"]], `
setTimeout(() => { document.querySelector("textarea").value = "03AF-partial"; }, 300);
setTimeout(() => { document.querySelector("textarea").value = "03AF-token"; }, 650);`)}`,
	// Turnstile passes invisibly: a token and never a state.
	"/turnstile": `<div style="height:3000px"></div><div class="cf-turnstile"><input type="hidden" name="cf-turnstile-response" value=""></div>
<script>new IntersectionObserver((entries, observer) => { if (entries[0].isIntersecting) { setTimeout(() => { document.querySelector("[name=cf-turnstile-response]").value = "0.turnstile"; }, 200); observer.disconnect(); } }).observe(document.querySelector(".cf-turnstile"));</script>`,
	"/empty-widget": `<div class="cf-turnstile"><input type="hidden" name="cf-turnstile-response" value=""></div>`,
	// The challenge navigates to the page it guarded, which the solver marks solved.
	"/navigates": `<script>setTimeout(() => { location.href = "/solved"; }, 200);</script>`,
};

describe.skipIf(!chromiumAvailable)("the solver's captcha state on a real page", () => {
	let server: ReturnType<typeof Bun.serve>;
	let browser: Browser;
	let page: Page;
	beforeAll(async () => {
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

	test("waits through solving and resolves true once solved", async () => {
		await open("/solved");
		const started = Date.now();
		expect(await waitForCaptchaSolved(page, { ...options, graceMs: 2_000 })).toBe(true);
		expect(Date.now() - started).toBeGreaterThanOrEqual(350);
	});

	test("a page that shows no challenge within the grace period resolves false", async () => {
		await open("/none");
		const started = Date.now();
		expect(await waitForCaptchaSolved(page, { ...options, graceMs: 400 })).toBe(false);
		expect(Date.now() - started).toBeGreaterThanOrEqual(400);
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	test("a challenge that appears within the grace period is waited for", async () => {
		await open("/late");
		expect(await waitForCaptchaSolved(page, { ...options, graceMs: 2_500 })).toBe(true);
	});

	test("failed throws at once with the solver's reason", async () => {
		await open("/failed");
		const error = await waitForCaptchaSolved(page, { ...options, graceMs: 2_000 }).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(CaptchaError);
		expect(error).toMatchObject({ state: "failed", detail: "recaptcha: image grid not solved", message: "The test captcha: the captcha solver failed (recaptcha: image grid not solved)" });
	});

	test("still solving at the deadline throws, naming the state and the adapter", async () => {
		await open("/stuck");
		const error = await waitForCaptchaSolved(page, { ...options, timeoutMs: 600, graceMs: 100 }).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(CaptchaError);
		expect((error as Error).message).toBe("The test captcha: the captcha was not solved within 1 s (solving: tcaptcha)");
	});

	test("an aborted signal ends the wait as a cancellation", async () => {
		await open("/stuck");
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		await expect(waitForCaptchaSolved(page, { ...options, signal: controller.signal })).rejects.toBeInstanceOf(OperationCanceledError);
	});

	test("a navigation during the wait is looked through, to the next page's state", async () => {
		await open("/navigates");
		expect(await waitForCaptchaSolved(page, { ...options, graceMs: 3_000 })).toBe(true);
		expect(page.url()).toEndWith("/solved");
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
