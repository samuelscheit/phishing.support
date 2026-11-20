import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { ProviderLoginError } from "../login_session/session";
import { ALIBABA_CLOUD_PROVIDER } from "./definition";
import { ALIBABA_SESSION_TTL_MS, alibabaCloudLoginConfig, browserReason, buildAlibabaCloudSession, consoleSecToken, loginWithContext, parseAlibabaCloudSession } from "./session";

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
		expect(session.id).toBe(createHash("sha256").update("ticket-1").digest("hex").slice(0, 32));
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

	/** A page whose login form is an iframe locator; `behaviour` can fail steps or show frames. */
	function fakeLogin(behaviour: { fill?: (selector: string, value: string) => Promise<void>; click?: () => Promise<void>; frames?: () => unknown[]; afterClick?: "console" | "stay"; verifyFrame?: unknown } = {}) {
		const calls: Calls = { frameLocators: [], fills: [], clicks: [], closed: 0 };
		let url = "about:blank";
		const page = {
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
		return { context: context as never, calls };
	}
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

	test("a refused sign-in does not quote the page's text; a slider check has no suffix", async () => {
		const frame = (result: { message: string; slider: boolean }) => ({ url: () => "https://passport.alibabacloud.com/mini_login.htm", evaluate: async () => result });
		const refused = fakeLogin({ afterClick: "stay", frames: () => [frame({ message: `The account ${config.email} does not exist`, slider: false })] });
		const refusal = await login(refused.context).catch((error) => error);
		expect(refusal).toBeInstanceOf(ProviderLoginError);
		expect(refusal.stage).toBe("Alibaba refused the sign-in");
		expect(refusal.message).not.toContain(config.email);
		expect(refusal.message).not.toContain("does not exist");

		const slider = fakeLogin({ afterClick: "stay", frames: () => [frame({ message: "", slider: true })] });
		expect((await login(slider.context).catch((error) => error)).stage).toBe("Alibaba asked for a slider check");
	});

	test("from an unknown browser the mailed code is requested, read and entered in the identity-check frame", async () => {
		const actions: string[] = [];
		const verify = { url: () => "https://passport.alibabacloud.com/identity_verify.htm", click: async (selector: string) => { actions.push(`click ${selector}`); }, fill: async (selector: string, value: string) => { actions.push(`fill ${selector} ${value}`); } };
		let opened = false;
		const { context, calls } = fakeLogin({ afterClick: "stay", frames: () => (opened ? [] : [verify]) });
		const readCode = async () => { opened = true; return "346070"; };
		const session = await login(context, { readCode });
		expect(actions).toEqual(["click #J_GetCode_Email", "fill #J_Checkcode 346070", "click .submit button"]);
		expect(session.secToken).toBe("Ak2GAMjWhLGnDwas6DsrS3");
		expect(calls.closed).toBe(1);
	});

	test("a failing code read keeps its stage and the reason, redacted", async () => {
		const verify = { url: () => "https://passport.alibabacloud.com/identity_verify.htm", click: async () => undefined, fill: async () => undefined };
		const { context } = fakeLogin({ afterClick: "stay", frames: () => [verify] });
		const failure = await login(context, { readCode: async () => { throw new Error(`mailbox for ${config.email} unreachable`); } }).catch((error) => error);
		expect(failure.stage).toBe("the mailed code did not arrive (mailbox for [redacted] unreachable)");
	});
});
