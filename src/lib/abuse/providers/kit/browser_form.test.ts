import { afterEach, describe, expect, test } from "bun:test";

import { BrowserFormError, openBrowserForm, type BrowserFormDependencies, type BrowserFormPage } from "./browser_form";
import { captchaTokenFromPage } from "./captcha";
import { captchaGlobals } from "../../../browser/captcha_test_support";
import { chromiumAvailable } from "../../../browser/task/test_helpers";
import { OperationCanceledError } from "../../worker/cancellation";
import { patchrightFormFixture } from "./testing";

type FakeElement = { name?: string; type?: string; value?: string; scrolled?: boolean; scrollIntoView?: (options: unknown) => void };

/**
 * A page that runs the helper's in-page functions in this process against a
 * scripted `document`, `window` and `fetch`: the code under test is the real one.
 */
class FakePage implements BrowserFormPage {
	title = "Just a moment...";
	elements = new Map<string, FakeElement | undefined>();
	/** The attributes Browser Fabric's solver publishes on the top document. */
	captcha: { "data-captcha-state"?: string; "data-captcha-detail"?: string } = {};
	/** The page's own globals, kept across looks as a real document keeps them. */
	globals = captchaGlobals();
	window = Object.assign(this.globals.window, { nonce: "abc123", nested: { value: 7, object: {} } });
	formElements: FakeElement[] = [];
	closed = false;
	gotos: { url: string; timeout: number }[] = [];
	gotoError: Error | undefined;
	/** Called before each evaluate, to move the page along (the challenge passing, a token appearing). */
	onEvaluate: (calls: number) => void = () => undefined;
	evaluations = 0;
	evaluateError: Error | undefined;
	/** Each in-page function by name, with the world Patchright would run it in. */
	worlds: [name: string, world: "page" | "isolated"][] = [];

	async goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }) {
		if (this.gotoError) throw this.gotoError;
		this.gotos.push({ url, timeout: options.timeout });
	}

	async evaluate<R, A>(pageFunction: (argument: A) => R | Promise<R>, argument: A, _options?: undefined, isolatedContext?: boolean): Promise<R> {
		this.evaluations++;
		this.worlds.push([pageFunction.name, isolatedContext === false ? "page" : "isolated"]);
		this.onEvaluate(this.evaluations);
		if (this.evaluateError) throw this.evaluateError;
		const document = {
			get title() { return page.title; },
			documentElement: { getAttribute: (name: "data-captcha-state" | "data-captcha-detail") => page.captcha[name] ?? null },
			querySelectorAll: (selector: string) => [page.elements.get(selector)].filter(Boolean),
			querySelector: (selector: string) => {
				if (selector.startsWith("form#") || selector === "form.f") return page.elements.get("form") ?? null;
				const element = page.elements.get(selector);
				// Every element of a real page can be scrolled to.
				if (element && !element.scrollIntoView) element.scrollIntoView = () => undefined;
				return element ?? null;
			},
		};
		const page = this;
		const form = { elements: this.formElements };
		const documentWithForm = { ...document, querySelector: (selector: string) => selector === "form.f" ? (this.elements.has("form") ? form : null) : document.querySelector(selector) };
		const scoped = globalThis as unknown as Record<string, unknown>;
		const saved = { document: scoped.document, window: scoped.window, MutationObserver: scoped.MutationObserver };
		this.globals.sync(this.captcha);
		scoped.document = documentWithForm;
		scoped.window = this.window;
		scoped.MutationObserver = this.globals.MutationObserver;
		try {
			return await pageFunction(argument);
		} finally {
			scoped.document = saved.document;
			scoped.window = saved.window;
			scoped.MutationObserver = saved.MutationObserver;
		}
	}

	async close() { this.closed = true; }
}

function harness(page = new FakePage(), overrides: Partial<BrowserFormDependencies> = {}) {
	const state = { released: 0, canceled: 0, clock: 0, slept: 0 };
	const dependencies: BrowserFormDependencies = {
		acquire: async () => ({ context: { newPage: async () => page } as never, release: async () => { state.released++; }, cancel: async () => { state.canceled++; } }),
		now: () => state.clock,
		sleep: async (ms) => { state.clock += ms; state.slept++; },
		...overrides,
	};
	const open = (extra: Partial<Parameters<typeof openBrowserForm>[0]> = {}) => openBrowserForm({ provider: "PDR", operation: "pdr-report", url: "https://example.test/form/", formSelector: "form.f", challengeTimeoutMs: 5_000, ...extra }, dependencies);
	return { page, state, open, dependencies };
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("openBrowserForm", () => {
	test("waits out the Cloudflare challenge, then returns once the form has rendered", async () => {
		const { page, state, open } = harness();
		page.onEvaluate = (calls) => {
			if (calls === 4) page.title = "Phishing report";
			if (calls === 4) page.elements.set("form", {});
		};
		const session = await open();
		expect(page.gotos).toEqual([{ url: "https://example.test/form/", timeout: 45_000 }]);
		expect(page.evaluations).toBe(4);
		expect(state.slept).toBe(3);
		expect(state.released).toBe(0);
		await session.close();
		await session.close();
		expect(page.closed).toBeTrue();
		expect(state.released).toBe(1);
	});

	test("a challenge DOM marker counts even under a normal title", async () => {
		const { page, open } = harness();
		page.title = "Phishing report";
		page.elements.set("form", {});
		page.elements.set("#challenge-running, #challenge-stage, #challenge-form, #cf-challenge-running, .cf-browser-verification", {});
		await expect(open({ challengeTimeoutMs: 1_000 })).rejects.toMatchObject({ stage: "challenge" });
	});

	test("a challenge that never passes names the stage and releases the browser", async () => {
		const { page, state, open } = harness();
		const error = await open().catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(BrowserFormError);
		expect((error as BrowserFormError).stage).toBe("challenge");
		expect((error as Error).message).toBe("PDR: the Cloudflare challenge was not passed within 5 s");
		expect(state.released).toBe(1);
		expect(page.closed).toBeTrue();
	});

	test("a page past the challenge without the form is a different stage", async () => {
		const { page, open } = harness();
		page.title = "Not found";
		await expect(open()).rejects.toMatchObject({ stage: "form", message: "PDR: the form (form.f) did not appear within 5 s" });
	});

	test("probes that throw while the page navigates are retried", async () => {
		const { page, open } = harness();
		page.onEvaluate = (calls) => {
			if (calls <= 2) page.evaluateError = new Error("Execution context was destroyed, most likely because of a navigation");
			else page.evaluateError = undefined;
			if (calls === 3) { page.title = "Report"; page.elements.set("form", {}); }
		};
		const session = await open();
		expect(page.evaluations).toBe(3);
		await session.close();
	});

	test("a page that does not load and a browser that is not available are named", async () => {
		const failing = harness();
		failing.page.gotoError = new Error("net::ERR_TUNNEL_CONNECTION_FAILED\nmore");
		await expect(failing.open()).rejects.toMatchObject({ stage: "load", message: "PDR: the form page did not load (net::ERR_TUNNEL_CONNECTION_FAILED more)" });
		expect(failing.state.released).toBe(1);
		const noBrowser = harness(undefined, { acquire: async () => { throw new Error("fabric down"); } });
		await expect(noBrowser.open()).rejects.toThrow("fabric down");
	});

	test("cancellation ends the wait, and the browser is released", async () => {
		const { state, open } = harness();
		const controller = new AbortController();
		const pending = open({ signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toBeInstanceOf(OperationCanceledError);
		expect(state.released).toBe(1);
	});
});

describe("session", () => {
	async function ready() {
		const fixture = harness();
		fixture.page.title = "Report";
		fixture.page.elements.set("form", {});
		return { ...fixture, session: await fixture.open() };
	}

	test("waits for the Turnstile token, scrolling the widget into view on every poll", async () => {
		const { page, session } = await ready();
		let scrolls = 0;
		const token: FakeElement = { value: "" };
		page.elements.set(".cf-turnstile", { scrollIntoView: () => { scrolls++; } });
		page.elements.set('input[name="cf-turnstile-response"]', token);
		const before = page.evaluations;
		page.onEvaluate = (calls) => { if (calls === before + 3) token.value = "0.TOKEN"; };
		expect(await session.waitForCaptchaToken("turnstile")).toBe("0.TOKEN");
		expect(scrolls).toBe(3);
	});

	test("no token within the bound, and no widget at all, are told apart", async () => {
		const { page, session } = await ready();
		page.elements.set(".cf-turnstile", { scrollIntoView: () => undefined });
		page.elements.set('input[name="cf-turnstile-response"]', { value: "" });
		await expect(session.waitForCaptchaToken("turnstile", { timeoutMs: 2_000 })).rejects.toMatchObject({ stage: "captcha", message: "PDR's Cloudflare Turnstile: no token within 2 s (no captcha state)" });
		page.elements.delete(".cf-turnstile");
		await expect(session.waitForCaptchaToken("turnstile", { timeoutMs: 1_000 })).rejects.toMatchObject({ stage: "captcha", message: "PDR's Cloudflare Turnstile: the widget (.cf-turnstile) is not on the page" });
	});

	test("a reCAPTCHA token is taken only once the solver says solved, never a half-written one", async () => {
		const { page, session } = await ready();
		const token: FakeElement = { value: "" };
		page.elements.set('textarea[name="g-recaptcha-response"]', token);
		const before = page.evaluations;
		page.onEvaluate = (calls) => {
			const look = calls - before;
			if (look === 1) page.captcha = { "data-captcha-state": "solving", "data-captcha-detail": "recaptcha" };
			if (look === 3) token.value = "03AF-stale";
			if (look === 5) Object.assign(token, { value: "03AF-TOKEN" }) && (page.captcha = { "data-captcha-state": "solved", "data-captcha-detail": "recaptcha" });
		};
		expect(await session.waitForCaptchaToken("recaptcha")).toBe("03AF-TOKEN");
		expect(page.evaluations - before).toBe(5);
	});

	test("a solver that gives up is a captcha-stage error with its reason, without waiting out the bound", async () => {
		const { page, session, state } = await ready();
		const before = page.evaluations;
		page.onEvaluate = (calls) => {
			if (calls === before + 1) page.captcha = { "data-captcha-state": "solving", "data-captcha-detail": "recaptcha" };
			if (calls === before + 3) page.captcha = { "data-captcha-state": "failed", "data-captcha-detail": "recaptcha: image grid not solved" };
		};
		await expect(session.waitForCaptchaToken("recaptcha")).rejects.toMatchObject({ stage: "captcha", message: "PDR's reCAPTCHA: the captcha solver failed (recaptcha: image grid not solved)" });
		expect(page.evaluations - before).toBe(3);
		expect(state.clock).toBe(1_000);
	});

	test("a failed verdict already on the page when the wait begins is an earlier challenge's: the wait carries on to this one's token", async () => {
		const { page, session } = await ready();
		page.captcha = { "data-captcha-state": "failed", "data-captcha-detail": "recaptcha: earlier challenge" };
		const token: FakeElement = { value: "" };
		page.elements.set('textarea[name="g-recaptcha-response"]', token);
		const before = page.evaluations;
		page.onEvaluate = (calls) => {
			if (calls === before + 3) page.captcha = { "data-captcha-state": "solving", "data-captcha-detail": "recaptcha" };
			if (calls === before + 5) { token.value = "03AF-NEW"; page.captcha = { "data-captcha-state": "solved", "data-captcha-detail": "recaptcha" }; }
		};
		expect(await session.waitForCaptchaToken("recaptcha")).toBe("03AF-NEW");
	});

	test("an earlier failed verdict nothing follows is named at the deadline, not taken as this wait's answer", async () => {
		const { page, session, state } = await ready();
		page.captcha = { "data-captcha-state": "failed", "data-captcha-detail": "recaptcha: earlier challenge" };
		page.elements.set('iframe[src*="/recaptcha/"][src*="/anchor"]', {});
		await expect(session.waitForCaptchaToken("recaptcha", { timeoutMs: 3_000 })).rejects.toMatchObject({
			stage: "captcha",
			message: "PDR's reCAPTCHA: no token within 3 s (no captcha state; before this wait: failed: recaptcha: earlier challenge)",
		});
		expect(state.clock).toBe(3_000);
	});

	test("a token present at the deadline is returned, though the solver still says solving", async () => {
		const { page, session } = await ready();
		page.elements.set('textarea[name="g-recaptcha-response"]', { value: "03AF-LATE" });
		page.onEvaluate = () => { page.captcha = { "data-captcha-state": "solving", "data-captcha-detail": "recaptcha" }; };
		expect(await session.waitForCaptchaToken("recaptcha", { timeoutMs: 2_000 })).toBe("03AF-LATE");
	});

	test("reads the form's matching named fields, not files, checkboxes or other inputs", async () => {
		const { page, session } = await ready();
		page.formElements.push(
			{ name: "_wpcf7", type: "hidden", value: "643" },
			{ name: "_wpcf7_posted_data_hash", type: "hidden", value: "" },
			{ name: "_wpcf7_ak_hp_textarea", type: "textarea", value: "" },
			{ name: "wpcf7_hp_field", type: "text", value: "" },
			{ name: "your-email", type: "email", value: "x@y.z" },
			{ name: "_wpcf7_file", type: "file", value: "C:\\fake" },
			{ name: "_wpcf7_box", type: "checkbox", value: "on" },
			{ type: "hidden", value: "no name" },
		);
		expect(await session.readFormFields("^_?wpcf7")).toEqual([["_wpcf7", "643"], ["_wpcf7_posted_data_hash", ""], ["_wpcf7_ak_hp_textarea", ""], ["wpcf7_hp_field", ""]]);
	});

	test("reads page globals by path, scalars only", async () => {
		const { session } = await ready();
		expect(await session.readGlobal("nonce")).toBe("abc123");
		expect(await session.readGlobal("nested.value")).toBe(7);
		expect(await session.readGlobal("nested.object")).toBeUndefined();
		expect(await session.readGlobal("missing.deeper")).toBeUndefined();
	});

	test("only probes of the page's own script state run in its world; everything that reads or drives the DOM stays isolated", async () => {
		const { page, session } = await ready();
		globalThis.fetch = (async () => new Response("{}")) as unknown as typeof fetch;
		page.worlds = [];
		await session.readGlobal("nonce");
		await session.evaluate(function pageScript() { return 1; }, undefined);
		await session.readFormFields("^x$");
		await session.postForm("https://example.test/post", []);
		await session.request({ method: "GET", url: "https://example.test/get" });
		await session.clickAll("label");
		await session.selectOption("select", "a");
		expect(page.worlds).toEqual([
			["globalProbe", "page"],
			["pageScript", "page"],
			["formFieldsProbe", "isolated"],
			["postProbe", "isolated"],
			["requestProbe", "isolated"],
			["clickAllProbe", "isolated"],
			["selectProbe", "isolated"],
		]);
	});

	test("posts multipart from the page with cookies, repeated names and files, and parses the JSON answer", async () => {
		const { session } = await ready();
		const seen: { url: string; init: RequestInit }[] = [];
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			seen.push({ url, init });
			return new Response('{"status":"mail_sent","message":"Thanks"}', { status: 200 });
		}) as never;
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
		const answer = await session.postForm("https://example.test/wp-json/feedback", [
			["a", "1"],
			["file[]", "x/shot.png"],
			["file[]", "x/two.png"],
			["upload", { filename: "shot.png", mimeType: "image/png", base64: png.toString("base64") }],
		]);
		expect(answer).toEqual({ status: 200, text: '{"status":"mail_sent","message":"Thanks"}', json: { status: "mail_sent", message: "Thanks" } });
		const init = seen[0]!.init;
		expect(init).toMatchObject({ method: "POST", credentials: "include" });
		expect(init.headers).not.toHaveProperty("content-type");
		const body = init.body as FormData;
		expect(body.getAll("file[]")).toEqual(["x/shot.png", "x/two.png"]);
		const file = body.get("upload") as File;
		expect([file.name, file.type]).toEqual(["shot.png", "image/png"]);
		expect(Buffer.from(await file.arrayBuffer())).toEqual(png);
	});

	test("reports the URL the page's fetch ended on after following a redirect", async () => {
		const { session } = await ready();
		const seen: RequestInit[] = [];
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			seen.push(init);
			return { status: 200, url: "https://example.test/thank-you", text: async () => "<html>Thanks</html>" };
		}) as never;
		const answer = await session.postForm("https://example.test/bin/lead", [["a", "1"]]);
		expect(answer).toEqual({ status: 200, text: "<html>Thanks</html>", json: undefined, url: "https://example.test/thank-you" });
		expect(seen[0]!.redirect).toBeUndefined();
	});

	test("a non-JSON answer keeps its status and text; a failed request names the stage", async () => {
		const { session } = await ready();
		globalThis.fetch = (async () => new Response("<html>Just a moment</html>", { status: 403 })) as never;
		expect(await session.postForm("https://example.test/x", [])).toEqual({ status: 403, text: "<html>Just a moment</html>", json: undefined });
		globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as never;
		await expect(session.postForm("https://example.test/wp-json/feedback", [])).rejects.toMatchObject({ stage: "request", message: "PDR: the request to /wp-json/feedback failed (Failed to fetch)" });
	});
});

describe("single-page forms (choice, form selector, request headers)", () => {
	async function ready() {
		const fixture = harness();
		fixture.page.title = "Report";
		fixture.page.elements.set("form", {});
		return { ...fixture, session: await fixture.open() };
	}

	function select(values: string[]) {
		const events: string[] = [];
		const element = { value: "", options: values.map((value) => ({ value })), dispatchEvent: (event: Event) => { events.push(event.type); return true; } };
		return { element, events };
	}

	test("selectOption chooses an offered option and fires input and change for the page's model", async () => {
		const { page, session } = await ready();
		const { element, events } = select(["1", "2", "7"]);
		page.elements.set("#type", element as never);
		expect(await session.selectOption("#type", "2")).toBeTrue();
		expect([element.value, events]).toEqual(["2", ["input", "change"]]);
	});

	test("selectOption is false, and changes nothing, for an absent select or option", async () => {
		const { page, session } = await ready();
		const { element, events } = select(["1", "7"]);
		page.elements.set("#type", element as never);
		expect(await session.selectOption("#type", "2")).toBeFalse();
		expect(await session.selectOption("#missing", "2")).toBeFalse();
		expect([element.value, events]).toEqual(["", []]);
	});

	test("readFormFields reads the form a selector names, not the one the session opened on", async () => {
		const { page, session } = await ready();
		page.formElements = [{ name: "_wpcf7", type: "hidden", value: "1" }];
		page.elements.set("form:has(x)", { elements: [{ name: "domains_2", type: "text", value: "" }, { name: "other", type: "text", value: "" }] } as never);
		expect(await session.readFormFields("^domains_2$", "form:has(x)")).toEqual([["domains_2", ""]]);
		expect(await session.readFormFields("^_wpcf7$")).toEqual([["_wpcf7", "1"]]);
	});

	test("postForm adds the caller's headers to the in-page request", async () => {
		const { session } = await ready();
		let seen: HeadersInit | undefined;
		globalThis.fetch = (async (_url: string, init: RequestInit) => { seen = init.headers; return new Response("{}", { status: 200 }); }) as never;
		await session.postForm("https://example.test/x", [], undefined, { "dyna-client-type": "Web" });
		expect(seen).toEqual({ accept: "application/json, */*;q=0.1", "dyna-client-type": "Web" });
	});
});

describe("clickAll and request (in-page controls and header-aware requests)", () => {
	/** A page whose document holds elements for `querySelectorAll`; the helper's in-page functions run for real. */
	async function opened(elements: Record<string, Array<{ box: { left: number; top: number }; events: MouseEvent[] }>>) {
		const page = {
			async goto() {},
			async close() {},
			async evaluate<R, A>(pageFunction: (argument: A) => R | Promise<R>, argument: A): Promise<R> {
				const scoped = globalThis as unknown as Record<string, unknown>;
				const saved = { document: scoped.document, window: scoped.window, MouseEvent: scoped.MouseEvent };
				scoped.window = {};
				scoped.MouseEvent = class { constructor(readonly type: string, readonly init: Record<string, unknown>) {} };
				scoped.document = {
					title: "Report",
					querySelector: (selector: string) => selector.includes("challenge") ? null : {},
					querySelectorAll: (selector: string) => (elements[selector] ?? []).map((element) => ({
						getBoundingClientRect: () => element.box,
						dispatchEvent: (event: MouseEvent) => { element.events.push(event); return true; },
					})),
				};
				try {
					return await pageFunction(argument);
				} finally {
					Object.assign(scoped, saved);
				}
			},
		};
		return openBrowserForm({ provider: "X", operation: "x", url: "https://example.test/", formSelector: "form" }, { acquire: async () => ({ context: { newPage: async () => page } as never, release: async () => undefined, cancel: async () => undefined }), now: () => 0, sleep: async () => undefined });
	}

	test("clickAll clicks every match 4 px inside its corner, bubbling, and counts them", async () => {
		const first = { box: { left: 10, top: 20 }, events: [] as MouseEvent[] };
		const second = { box: { left: 10, top: 60 }, events: [] as MouseEvent[] };
		const session = await opened({ label: [first, second] });
		expect(await session.clickAll("label")).toBe(2);
		expect(await session.clickAll("nothing")).toBe(0);
		expect([first.events, second.events].map(([event]) => (event as unknown as { type: string; init: Record<string, unknown> }))).toMatchObject([
			{ type: "click", init: { bubbles: true, cancelable: true, clientX: 14, clientY: 24 } },
			{ type: "click", init: { clientX: 14, clientY: 64 } },
		]);
	});

	test("request sends JSON with the caller's headers and returns the response headers lower-cased", async () => {
		const session = await opened({});
		const seen: Array<{ url: string; init: RequestInit }> = [];
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			seen.push({ url, init });
			return new Response('{"ok":true}', { status: 201, headers: { "X-Csrf-Token-Auth": "tok", "content-type": "application/json" } });
		}) as never;
		const answer = await session.request({ method: "POST", url: "https://example.test/api", headers: { "x-csrf-token-auth": "abc" }, json: { a: 1 } });
		expect(answer).toMatchObject({ status: 201, json: { ok: true }, headers: { "x-csrf-token-auth": "tok", "content-type": "application/json" } });
		expect(seen[0]!.init).toMatchObject({ method: "POST", credentials: "include", body: '{"a":1}', headers: { accept: "application/json, text/plain, */*", "x-csrf-token-auth": "abc", "content-type": "application/json" } });
		await session.request({ method: "GET", url: "https://example.test/csrf" });
		expect(seen[1]!.init.body).toBeUndefined();
	});

	test("a failing request names the request stage", async () => {
		const session = await opened({});
		globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as never;
		await expect(session.request({ method: "GET", url: "https://example.test/csrf" })).rejects.toMatchObject({ stage: "request", message: "X: the request to /csrf failed (Failed to fetch)" });
	});
});

describe("captchaTokenFromPage (the Fabric preflight of a provider that files over HTTP)", () => {
	const spec = { provider: "NameSilo", operation: "namesilo-report", url: "https://example.test/phishing-report", formSelector: "form.f", kind: "recaptcha" as const };
	const rendered = () => {
		const fixture = harness();
		fixture.page.title = "Phishing report";
		fixture.page.elements.set("form", {});
		return fixture;
	};

	test("opens the provider's page, returns the token the solver passed, and releases the browser", async () => {
		const { page, state, dependencies } = rendered();
		page.captcha = { "data-captcha-state": "solved", "data-captcha-detail": "recaptcha" };
		page.elements.set('textarea[name="g-recaptcha-response"]', { value: "03AF-TOKEN" });
		expect(await captchaTokenFromPage(spec, undefined, dependencies)).toBe("03AF-TOKEN");
		expect(page.gotos.map(({ url }) => url)).toEqual([spec.url]);
		expect([page.closed, state.released]).toEqual([true, 1]);
	});

	test("a solver that fails, or no token within the bound, still releases the browser", async () => {
		const failed = rendered();
		failed.page.onEvaluate = (calls) => { if (calls > 2) failed.page.captcha = { "data-captcha-state": "failed", "data-captcha-detail": "recaptcha: image grid not solved" }; };
		await expect(captchaTokenFromPage(spec, undefined, failed.dependencies)).rejects.toMatchObject({ stage: "captcha", message: "NameSilo's reCAPTCHA: the captcha solver failed (recaptcha: image grid not solved)" });
		expect([failed.page.closed, failed.state.released]).toEqual([true, 1]);

		const slow = rendered();
		slow.page.captcha = { "data-captcha-state": "solving", "data-captcha-detail": "recaptcha" };
		await expect(captchaTokenFromPage({ ...spec, timeoutMs: 3_000 }, undefined, slow.dependencies)).rejects.toMatchObject({ stage: "captcha", message: "NameSilo's reCAPTCHA: no token within 3 s (solving: recaptcha)" });
		expect([slow.page.closed, slow.state.released]).toEqual([true, 1]);
	});

	test("a page that never renders past Cloudflare releases the browser before any token is looked for", async () => {
		const { page, state, dependencies } = harness();
		await expect(captchaTokenFromPage({ ...spec, timeoutMs: 3_000 }, undefined, { ...dependencies })).rejects.toMatchObject({ stage: "challenge" });
		expect([page.closed, state.released]).toEqual([true, 1]);
	});

	test("an abort while the solver works cancels the wait and releases the browser", async () => {
		const { page, state, dependencies } = rendered();
		page.captcha = { "data-captcha-state": "solving", "data-captcha-detail": "recaptcha" };
		const controller = new AbortController();
		page.onEvaluate = (calls) => { if (calls === 4) controller.abort(); };
		await expect(captchaTokenFromPage(spec, controller.signal, dependencies)).rejects.toBeInstanceOf(OperationCanceledError);
		expect([page.closed, state.released]).toEqual([true, 1]);
	});
});

/**
 * Patchright runs `evaluate` in an isolated world by default: it shares the
 * DOM but none of the page's JavaScript. In production that hid GoDaddy's
 * `grecaptcha` and PublicDomainRegistry's `dnd_cf7_uploader` from the form
 * session, though both pages had loaded them.
 */
describe.skipIf(!chromiumAvailable)("a real Patchright page: the page's own globals, and DOM probes the page cannot tamper with", () => {
	const FORM = `<!doctype html><html><head><title>Report</title></head><body>
<form class="f"><input name="nonce_field" value="from-dom"></form>
<script>
window.cfg = { nonce: "n-1", depth: { value: 7 } };
// Only the page's own world sees this: a DOM probe in the isolated world must not.
Document.prototype.querySelector = function () { return null; };
</script></body></html>`;
	let fixture: Awaited<ReturnType<typeof patchrightFormFixture>> | undefined;
	afterEach(async () => { await fixture?.close(); fixture = undefined; });

	test("readGlobal and evaluate see what the page's scripts set; the default world does not", async () => {
		fixture = await patchrightFormFixture({ "/form": FORM });
		const session = await openBrowserForm({ provider: "X", operation: "x", url: "https://forms.example/form", formSelector: "form.f", challengeTimeoutMs: 10_000 }, { acquire: fixture.acquire });
		try {
			expect(await session.readGlobal("cfg.nonce")).toBe("n-1");
			expect(await session.readGlobal("cfg.depth.value")).toBe(7);
			expect(await session.evaluate((path: string) => typeof (window as unknown as Record<string, unknown>)[path], "cfg")).toBe("object");
			// The control: Patchright's default world on the very same page.
			const [page] = fixture.context.pages();
			expect(await page!.evaluate(() => typeof (window as unknown as { cfg?: unknown }).cfg)).toBe("undefined");
			// The page broke querySelector in its own world; the form probes, isolated, still find the form.
			expect(await session.readFormFields("^nonce_field$")).toEqual([["nonce_field", "from-dom"]]);
		} finally {
			await session.close();
		}
		expect(fixture.released()).toBe(1);
	});
});
