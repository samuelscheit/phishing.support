import { describe, expect, test } from "bun:test";

import { captchaGlobals } from "../../../browser/captcha_test_support";
import { ProviderLoginError } from "../login_session/session";
import { ALIBABA_CLOUD_PROVIDER } from "./definition";
import { ALIBABA_SESSION_TTL_MS, alibabaCloudLoginConfig, browserReason, buildAlibabaCloudSession, consoleSecToken, loginWithContext, parseAlibabaCloudSession } from "./session";
import { sha256Hex } from "../../../util/hash";

describe("consoleSecToken", () => {
	test("reads the token from the console page's script", () => {
		expect(consoleSecToken(`<script>window.ALIYUN_CONSOLE_CONFIG = {\n  SEC_TOKEN: "Ak2GAMjWhLGnDwas6DsrS3",\n  FEATURE: true };</script>`)).toBe("Ak2GAMjWhLGnDwas6DsrS3");
		expect(consoleSecToken(`SEC_TOKEN : 'abc_DEF-12345678'`)).toBe("abc_DEF-12345678");
		expect(consoleSecToken(`{"SEC_TOKEN":"x"}`)).toBeUndefined();
	});

	test("refuses a missing, short, long or oddly-charactered token, and a longer property name", () => {
		expect(consoleSecToken("<html>login</html>")).toBeUndefined();
		expect(consoleSecToken(`SEC_TOKEN: ""`)).toBeUndefined();
		expect(consoleSecToken(`SEC_TOKEN: "short"`)).toBeUndefined();
		expect(consoleSecToken(`SEC_TOKEN: "${"a".repeat(129)}"`)).toBeUndefined();
		expect(consoleSecToken(`SEC_TOKEN: "${"a".repeat(128)}"`)).toBe("a".repeat(128));
		expect(consoleSecToken(`SEC_TOKEN: "abc def ghi jkl"`)).toBeUndefined();
		expect(consoleSecToken(`OLD_SEC_TOKEN: "Ak2GAMjWhLGnDwas6DsrS3"`)).toBeUndefined();
	});
});

describe("buildAlibabaCloudSession", () => {
	const cookies = [
		{ name: "cna", value: "c", domain: ".alibabacloud.com", path: "/", httpOnly: true } as never,
		{ name: "login_aliyunid_ticket", value: "ticket-1", domain: ".alibabacloud.com" },
	];

	test("needs the login ticket cookie", () => {
		expect(() => buildAlibabaCloudSession([], "Ak2GAMjWhLGnDwas6DsrS3", 0)).toThrow("missing login ticket");
		expect(() => buildAlibabaCloudSession([cookies[0]!], "Ak2GAMjWhLGnDwas6DsrS3", 0)).toThrow("missing login ticket");
		expect(() => buildAlibabaCloudSession([{ name: "login_aliyunid_ticket", value: "", domain: "x" }], "Ak2GAMjWhLGnDwas6DsrS3", 0)).toThrow("missing login ticket");
	});

	test("identifies the session by a hash of the ticket (never the ticket), keeps only name, value and domain, and expires after the bound", () => {
		const session = buildAlibabaCloudSession(cookies, "Ak2GAMjWhLGnDwas6DsrS3", 1_000);
		expect(session.id).toBe(sha256Hex("ticket-1").slice(0, 32));
		expect(session.id).not.toContain("ticket-1");
		expect(session.expiresAt).toBe(1_000 + ALIBABA_SESSION_TTL_MS);
		expect(session.secToken).toBe("Ak2GAMjWhLGnDwas6DsrS3");
		expect(session.cookies).toEqual([{ name: "cna", value: "c", domain: ".alibabacloud.com" }, { name: "login_aliyunid_ticket", value: "ticket-1", domain: ".alibabacloud.com" }]);
		// A new ticket is a new session id (relogin invalidates the cached one).
		expect(buildAlibabaCloudSession([{ ...cookies[1]!, value: "ticket-2" }], "t".repeat(10), 0).id).not.toBe(session.id);
	});
});

describe("parseAlibabaCloudSession", () => {
	const valid = { id: "i", secToken: "s", expiresAt: 5, cookies: [{ name: "a", value: "b", domain: "c" }] };

	test("round-trips a stored session and drops extra fields", () => {
		expect(parseAlibabaCloudSession(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
		expect(parseAlibabaCloudSession({ ...valid, extra: 1, cookies: [{ ...valid.cookies[0], httpOnly: true }] })).toEqual(valid);
		expect(parseAlibabaCloudSession({ ...valid, cookies: [] })).toEqual({ ...valid, cookies: [] });
	});

	test("rejects every malformed shape", () => {
		for (const value of [
			undefined, null, 1, "x", [],
			{ ...valid, id: 1 }, { ...valid, secToken: undefined }, { ...valid, expiresAt: "5" }, { ...valid, cookies: "a" }, { ...valid, cookies: undefined },
			{ ...valid, cookies: [null] }, { ...valid, cookies: ["a=b"] },
			{ ...valid, cookies: [{ name: "a", value: "b" }] },
			{ ...valid, cookies: [{ name: "a", value: 2, domain: "c" }] },
			{ ...valid, cookies: [valid.cookies[0], { name: 1, value: "b", domain: "c" }] },
		]) expect(parseAlibabaCloudSession(value)).toBeUndefined();
	});
});

describe("alibabaCloudLoginConfig", () => {
	test("returns the trimmed email and the password untouched", () => {
		expect(alibabaCloudLoginConfig({ ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL: "  support@phishing.support ", ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD: " pw with space " })).toEqual({ email: "support@phishing.support", password: " pw with space " });
	});

	test("requires an email-shaped login and a non-empty password, naming the variable", () => {
		const password = "pw";
		for (const email of [undefined, "", "   ", "no-at-sign", "a@b", "a b@c.d", "@c.d", "a@@c.d"]) {
			expect(() => alibabaCloudLoginConfig({ ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL: email, ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD: password })).toThrow("ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL");
		}
		for (const bad of [undefined, ""]) expect(() => alibabaCloudLoginConfig({ ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL: "a@b.c", ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD: bad })).toThrow("ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD");
	});
});

describe("browserReason", () => {
	const config = { email: "support@phishing.support", password: "s3cret-pw" };

	test("keeps the first line only, at most 160 characters", () => {
		expect(browserReason(new Error("Timeout 30000ms exceeded.\n  - waiting for locator"), config)).toBe("Timeout 30000ms exceeded.");
		expect(browserReason(new Error("x".repeat(500)), config)).toBe("x".repeat(160));
	});

	test("replaces the email and the password wherever they occur", () => {
		expect(browserReason(new Error(`fill "${config.email}" then "${config.password}", again ${config.email}`), config)).toBe(`fill "[redacted]" then "[redacted]", again [redacted]`);
		// A secret on a later line never shows.
		expect(browserReason(new Error(`failed\n${config.password}`), config)).toBe("failed");
	});

	test("accepts non-Error values and gives a reason when there is none", () => {
		expect(browserReason("plain text", config)).toBe("plain text");
		expect(browserReason(new Error(""), config)).toBe("no reason given");
		expect(browserReason(undefined, config)).toBe("undefined");
	});
});

describe("loginWithContext", () => {
	const config = { email: "support@phishing.support", password: "s3cret-pw" };
	const origin = ALIBABA_CLOUD_PROVIDER.consoleOrigin;
	const TOKEN_PAGE = `<script>window.ALIYUN_CONSOLE_CONFIG = { SEC_TOKEN: "Ak2GAMjWhLGnDwas6DsrS3" };</script>`;

	type Calls = { frameLocators: string[]; fills: Array<[string, string]>; clicks: Array<[string, unknown]>; closed: number };

	type Captcha = { state?: "solving" | "solved" | "failed"; detail?: string };

	/**
	 * A page whose login form is an iframe locator; `behaviour` can fail steps
	 * or show frames, and `captcha` plays Browser Fabric's solver: the state it
	 * publishes on the top document at each look.
	 */
	function fakeLogin(behaviour: { fill?: (selector: string, value: string) => Promise<void>; click?: () => Promise<void>; frames?: () => unknown[]; afterClick?: "console" | "stay"; captcha?: () => Captcha } = {}) {
		const calls: Calls = { frameLocators: [], fills: [], clicks: [], closed: 0 };
		let url = "about:blank";
		const globals = captchaGlobals();
		const page = {
			evaluate: async (pageFunction: (argument: unknown) => unknown, argument: unknown) => {
				const captcha = behaviour.captcha?.() ?? {};
				const attributes: Record<string, string | undefined> = { "data-captcha-state": captcha.state, "data-captcha-detail": captcha.detail };
				globals.sync(attributes);
				const scoped = globalThis as { document?: unknown; window?: unknown; MutationObserver?: unknown };
				scoped.document = { documentElement: { getAttribute: (name: string) => attributes[name] ?? null }, querySelector: () => null, querySelectorAll: () => [] };
				scoped.window = globals.window;
				scoped.MutationObserver = globals.MutationObserver;
				try { return await pageFunction(argument); } finally { delete scoped.document; delete scoped.window; delete scoped.MutationObserver; }
			},
			goto: async (target: string) => { url = target; },
			frameLocator: (selector: string) => {
				calls.frameLocators.push(selector);
				return {
					locator: (inner: string) => ({
						fill: async (value: string) => { calls.fills.push([inner, value]); await behaviour.fill?.(inner, value); },
						click: async (options: unknown) => {
							calls.clicks.push([inner, options]);
							await behaviour.click?.();
							if (behaviour.afterClick !== "stay") url = `${origin}/`;
						},
					}),
				};
			},
			frames: () => behaviour.frames?.() ?? [],
			url: () => url,
			waitForTimeout: async () => undefined,
			waitForURL: async () => undefined,
			waitForLoadState: async () => undefined,
			content: async () => TOKEN_PAGE,
			close: async () => { calls.closed += 1; },
		};
		const context = {
			newPage: async () => page,
			cookies: async () => [{ name: "login_aliyunid_ticket", value: "ticket-1", domain: ".alibabacloud.com" }],
		};
		return { context: context as never, calls, setUrl: (next: string) => { url = next; } };
	}
	/** A frame with no slider in it, as far as the slider check can tell. */
	const plainFrame = (url: string, extras: Record<string, unknown> = {}) => ({ url: () => url, locator: () => ({ first: () => ({ isVisible: async () => false }) }), ...extras });
	const MINI_LOGIN = "https://passport.alibabacloud.com/mini_login.htm";
	const VERIFY = "https://passport.alibabacloud.com/identity_verify.htm";
	/** A mini_login frame whose DOM has these error blocks; its `evaluate` runs the page function against them. */
	function miniLoginFrame(errors: Record<string, string>) {
		return plainFrame(MINI_LOGIN, {
			evaluate: async (pageFunction: () => unknown) => {
				const document = { querySelectorAll: (selector: string) => Object.entries(errors).filter(([name]) => selector.split(",").some((part) => part.trim() === `.${name}`)).map(([, innerText]) => ({ innerText })) };
				(globalThis as { document?: unknown }).document = document;
				try { return pageFunction(); } finally { delete (globalThis as { document?: unknown }).document; }
			},
		});
	}
	/** A clock that moves a minute per reading, so a login that waits ends at its deadline. */
	const tickingClock = () => { let now = 0; return () => (now += 60_000); };
	const login = (context: never, dependencies = {}) => loginWithContext(context, config, new AbortController().signal, dependencies);

	test("fills and clicks through the form frame's locators, the click without waiting for navigation, and returns the session", async () => {
		const { context, calls } = fakeLogin();
		const session = await login(context);
		expect(calls.frameLocators).toEqual(["iframe#alibaba-login-box"]);
		expect(calls.fills).toEqual([["#fm-login-id", config.email], ["#fm-login-password", config.password]]);
		expect(calls.clicks).toHaveLength(1);
		expect(calls.clicks[0]![0]).toBe("#fm-login-submit");
		expect(calls.clicks[0]![1]).toMatchObject({ noWaitAfter: true });
		expect(session).toMatchObject({ secToken: "Ak2GAMjWhLGnDwas6DsrS3", cookies: [{ name: "login_aliyunid_ticket", value: "ticket-1" }] });
		expect(calls.closed).toBe(1);
	});

	test("a browser failure names the step and the browser's reason with the typed values redacted", async () => {
		const { context, calls } = fakeLogin({ fill: async (_selector, value) => { if (value === config.password) throw new Error(`locator.fill: Timeout for ${config.email} / ${config.password}\n  call log: ...`); } });
		const failure = await login(context).catch((error) => error);
		expect(failure).toBeInstanceOf(ProviderLoginError);
		expect(failure.stage).toBe("the login form did not appear (locator.fill: Timeout for [redacted] / [redacted])");
		expect(failure.message).not.toContain(config.password);
		expect(failure.message).not.toContain(config.email);
		expect(calls.closed).toBe(1);
	});

	test("a failed click is reported at its own step", async () => {
		const { context } = fakeLogin({ click: async () => { throw new Error("Frame was detached"); } });
		const failure = await login(context).catch((error) => error);
		expect(failure.stage).toBe("the login button could not be pressed (Frame was detached)");
	});

	test("a non-empty error block in the mini_login frame ends in a refusal that does not quote the page's text", async () => {
		for (const block of ["form-error", "login-error-msg", "fm-error"]) {
			const refused = fakeLogin({ afterClick: "stay", frames: () => [miniLoginFrame({ [block]: `The account ${config.email} does not exist` })] });
			const refusal = await login(refused.context).catch((error) => error);
			expect(refusal).toBeInstanceOf(ProviderLoginError);
			expect(refusal.stage).toBe("Alibaba refused the sign-in");
			expect(refusal.message).not.toContain(config.email);
			expect(refusal.message).not.toContain("does not exist");
			expect(refused.calls.closed).toBe(1);
		}
	});

	test("empty or blank error blocks are not a refusal: the login keeps waiting until its deadline", async () => {
		const empty = fakeLogin({ afterClick: "stay", frames: () => [miniLoginFrame({ "form-error": "", "login-error-msg": "  \n\t ", "fm-error": "" })] });
		const failure = await login(empty.context, { clock: tickingClock() }).catch((error) => error);
		expect(failure).toBeInstanceOf(ProviderLoginError);
		expect(failure.stage).toStartWith("the login page neither opened the console nor asked for the mailed code (Alibaba's sign-in: not done within ");
		expect(failure.stage).toEndWith(" s (no captcha state))");
	});

	test("a frame that cannot be evaluated (detached) is not a refusal either", async () => {
		const detached = plainFrame(MINI_LOGIN, { evaluate: async () => { throw new Error("Frame was detached"); } });
		const { context } = fakeLogin({ afterClick: "stay", frames: () => [detached] });
		expect((await login(context, { clock: tickingClock() }).catch((error) => error)).stage).toStartWith("the login page neither opened the console nor asked for the mailed code (Alibaba's sign-in: not done within ");
	});

	test("while the browser's solver works on a slider after sign-in the login waits, and carries on to the console once it passed", async () => {
		let looks = 0;
		const fake = fakeLogin({
			afterClick: "stay",
			// Baxia's slider: solving for a few looks, then passed, and the request it held replayed into the console.
			captcha: () => {
				looks++;
				if (looks === 4) fake.setUrl(`${origin}/`);
				return looks < 4 ? { state: "solving", detail: "aliyun-nc" } : { state: "solved", detail: "aliyun-nc" };
			},
		});
		const session = await login(fake.context);
		expect(session.secToken).toBe("Ak2GAMjWhLGnDwas6DsrS3");
		// Three looks while solving, the one that saw the console, and the console wait's own.
		expect(looks).toBe(5);
		expect(fake.calls.closed).toBe(1);
	});

	test("a failed verdict an earlier slider left on the page does not end the login: the console still opens", async () => {
		let looks = 0;
		const fake = fakeLogin({
			afterClick: "stay",
			captcha: () => {
				if (++looks === 3) fake.setUrl(`${origin}/`);
				return { state: "failed", detail: "aliyun-nc: an earlier slider" };
			},
		});
		expect((await login(fake.context)).secToken).toBe("Ak2GAMjWhLGnDwas6DsrS3");
	});

	test("a solver that gives up on the slider ends the login at once, naming its reason", async () => {
		let looks = 0;
		const fake = fakeLogin({ afterClick: "stay", captcha: () => (++looks < 3 ? { state: "solving", detail: "aliyun-nc" } : { state: "failed", detail: "aliyun-nc: refused 3 drags" }) });
		const failure = await login(fake.context).catch((error) => error);
		expect(failure).toBeInstanceOf(ProviderLoginError);
		expect(failure.stage).toBe("the login page neither opened the console nor asked for the mailed code (Alibaba's sign-in: the captcha solver failed (aliyun-nc: refused 3 drags))");
		expect(fake.calls.closed).toBe(1);
	});

	test("a slider still being solved at the login's deadline is named in the failure", async () => {
		const fake = fakeLogin({ afterClick: "stay", captcha: () => ({ state: "solving", detail: "aliyun-nc" }) });
		const failure = await login(fake.context, { clock: tickingClock() }).catch((error) => error);
		expect(failure.stage).toEndWith(" s (solving: aliyun-nc))");
	});

	test("the mailed code is read while the solver works on the code request's slider", async () => {
		const order: string[] = [];
		let state: Captcha = {};
		const verify = plainFrame(VERIFY, {
			click: async (selector: string) => {
				order.push(`click ${selector}`);
				if (selector === "#J_GetCode_Email") state = { state: "solving", detail: "aliyun-nc" };
				if (selector === ".submit button") fake.setUrl(`${origin}/`);
			},
			fill: async (selector: string, value: string) => { order.push(`fill ${selector} ${value}`); },
		});
		const fake = fakeLogin({ afterClick: "stay", frames: () => [verify], captcha: () => state });
		await login(fake.context, { readCode: async () => { order.push("read"); state = { state: "solved", detail: "aliyun-nc" }; return "123456"; } });
		expect(order).toEqual(["click #J_GetCode_Email", "read", "fill #J_Checkcode 123456", "click .submit button"]);
	});

	test("a solver that gives up on the code request's slider ends the wait for the code, which would never come", async () => {
		const verify = plainFrame(VERIFY, { click: async () => undefined, fill: async () => undefined });
		let requested = false;
		// The slider shows up with the code request and fails while the code is awaited.
		let looksSince = 0;
		const fake = fakeLogin({ afterClick: "stay", frames: () => [verify], captcha: () => (requested && ++looksSince > 1 ? { state: "failed", detail: "aliyun-nc: refused" } : {}) });
		let reading: AbortSignal | undefined;
		const failure = await login(fake.context, { readCode: (_since: Date, signal?: AbortSignal) => { requested = true; reading = signal; return new Promise<string>(() => undefined); } }).catch((error) => error);
		expect(failure.stage).toBe("the mailed code did not arrive (Alibaba's code request: the captcha solver failed (aliyun-nc: refused))");
		expect(fake.calls.closed).toBe(1);
		// The mailbox is not polled on for a code that will never come.
		expect(reading?.aborted).toBeTrue();
	});
	test("from an unknown browser the mailed code is requested, read and entered in the identity-check frame", async () => {
		const actions: string[] = [];
		const verify = plainFrame(VERIFY, { click: async (selector: string) => { actions.push(`click ${selector}`); }, fill: async (selector: string, value: string) => { actions.push(`fill ${selector} ${value}`); } });
		let opened = false;
		const { context, calls, setUrl } = fakeLogin({ afterClick: "stay", frames: () => (opened ? [] : [verify]) });
		const readCode = async () => { opened = true; setUrl(`${origin}/`); return "346070"; };
		const session = await login(context, { readCode });
		expect(actions).toEqual(["click #J_GetCode_Email", "fill #J_Checkcode 346070", "click .submit button"]);
		expect(session.secToken).toBe("Ak2GAMjWhLGnDwas6DsrS3");
		expect(calls.closed).toBe(1);
	});

	test("a failing code read keeps its stage and the reason, redacted", async () => {
		const verify = plainFrame(VERIFY, { click: async () => undefined, fill: async () => undefined });
		const { context } = fakeLogin({ afterClick: "stay", frames: () => [verify] });
		const failure = await login(context, { readCode: async () => { throw new Error(`mailbox for ${config.email} unreachable`); } }).catch((error) => error);
		expect(failure.stage).toBe("the mailed code did not arrive (mailbox for [redacted] unreachable)");
	});
});
