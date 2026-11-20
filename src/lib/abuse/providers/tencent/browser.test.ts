import { afterEach, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "patchright";

import { chromiumAvailable } from "../../../browser/task/test_helpers";
import { openTencentForm, type TencentFormInput } from "./browser";

const chromiumExecutable = process.env.PHISHING_TEST_CHROMIUM
	?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

const INPUT: TencentFormInput = {
	domain: "phish.example",
	url: "https://phish.example/login",
	category: "Phishing",
	describe: "The page impersonates Example Bank.",
	name: "Phishing Support",
	email: "support@phishing.support",
	countryName: "Germany",
	screenshot: { filename: "shot.png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
};

/**
 * Tencent's DNS-abuse form as the provider code drives it: its fields and
 * dropdowns, and a submit that opens the slide puzzle. `solver` plays Browser
 * Fabric's solver on that puzzle; once it passes, the page sends its own
 * filing request with the ticket, as the real widget's callback does.
 */
const formPage = (solver: { passes: true; afterMs: number } | { failure: string }) => `<!DOCTYPE html><html><body><form>
<input name="domain"><input name="url"><input name="infringedUrl">
<div class="tea-dropdown__header">Category</div><label name="Phishing" onclick="window.category='Phishing'">Phishing</label>
<textarea name="describe"></textarea><input type="file" name="file">
<input name="name"><input name="email">
<a class="dropdown-link">Country</a><ul class="dropdown-menu"><li><a onclick="window.country='Germany'">Germany</a></li></ul>
<input type="checkbox" name="privacyCheckbox1"><input type="checkbox" name="privacyCheckbox2">
<button type="submit">Submit</button></form>
<script>
const solver = ${JSON.stringify(solver)};
document.querySelector("form").addEventListener("submit", (event) => {
	event.preventDefault();
	const root = document.documentElement;
	root.setAttribute("data-captcha-detail", "tcaptcha");
	root.setAttribute("data-captcha-state", "solving");
	setTimeout(() => {
		if (solver.failure) { root.setAttribute("data-captcha-detail", solver.failure); root.setAttribute("data-captcha-state", "failed"); return; }
		root.setAttribute("data-captcha-state", "solved");
		const field = (name) => document.querySelector("[name=" + name + "]").value;
		fetch("/main/ajax/reportDsaPlatform/createDomainReport", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
			action: "createDomainReport",
			payload: { captcha: { ret: 0, ticket: "t-1", randstr: "r-1" }, formData: { domain: field("domain"), url: field("url"), describe: field("describe"), category: [window.category], country_name: window.country } },
		}) }).catch(() => undefined);
	}, solver.afterMs ?? 1_500);
});
</script></body></html>`;

describe.skipIf(!chromiumAvailable)("Tencent's form in a real browser, its slider left to the browser's solver", () => {
	let browser: Browser | undefined;
	afterEach(async () => { await browser?.close(); browser = undefined; });

	/** A browser whose every request is answered here: the form page, a fake filing answer, and nothing that leaves the machine. */
	async function open(solver: Parameters<typeof formPage>[0]) {
		browser = await chromium.launch({ executablePath: chromiumExecutable, headless: true });
		const context = await browser.newContext();
		const reached: string[] = [];
		await context.route("**/*", async (route) => {
			const url = new URL(route.request().url());
			reached.push(`${route.request().method()} ${url.pathname}`);
			if (url.pathname === "/report-platform/dnsabuse") return route.fulfill({ contentType: "text/html", body: formPage(solver) });
			if (url.pathname === "/main/ajax/reportDsaPlatform/createDomainReport") return route.fulfill({ contentType: "application/json", body: '{"code":0,"msg":"ok","data":{"code":"0"}}' });
			return route.abort();
		});
		let released = 0;
		const session = await openTencentForm(undefined, { acquire: async () => ({ context: context as never, release: async () => { released++; }, cancel: async () => undefined }) });
		return { session, reached, released: () => released };
	}

	test("the request the page sends once the solver passed the slider is caught and aborted; send replays it once", async () => {
		const { session, reached, released } = await open({ passes: true, afterMs: 1_500 });
		const caught = await session.captureRequest(INPUT);
		expect(caught).toMatchObject({ url: "https://www.tencentcloud.com/main/ajax/reportDsaPlatform/createDomainReport", method: "POST", contentType: "application/json" });
		expect(JSON.parse(caught.body)).toMatchObject({ payload: { captcha: { ret: 0, ticket: "t-1" }, formData: { domain: "phish.example", url: "https://phish.example/login", category: ["Phishing"], country_name: "Germany" } } });
		// The page's own filing request never got past the guard.
		expect(reached.filter((line) => line.includes("createDomainReport"))).toEqual([]);
		expect(await session.send(caught)).toEqual({ status: 200, text: '{"code":0,"msg":"ok","data":{"code":"0"}}' });
		expect(reached.filter((line) => line.includes("createDomainReport"))).toEqual(["POST /main/ajax/reportDsaPlatform/createDomainReport"]);
		await session.close();
		expect(released()).toBe(1);
	}, 60_000);

	test("a solver that gives up ends the preflight with its reason, and nothing is sent", async () => {
		const { session, reached } = await open({ failure: "tcaptcha: puzzle refused 3 times" });
		const error = await session.captureRequest(INPUT).catch((caught: unknown) => caught);
		expect((error as Error).message).toBe("Tencent Cloud form could not be prepared: Tencent Cloud's slider: the captcha solver failed (tcaptcha: puzzle refused 3 times)");
		expect(reached.filter((line) => line.includes("createDomainReport"))).toEqual([]);
		await session.close();
	}, 60_000);
});
