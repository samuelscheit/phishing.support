import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { GOOGLE_CLOUD_PROVIDER } from "../google_cloud/definition";
import { solveGoogleCloudCaptcha } from "../google_cloud/submission";
import { NAMESILO_PROVIDER } from "../namesilo/definition";
import { solveNameSiloCaptcha } from "../namesilo/submission";
import { NEWFOLD_PROVIDER } from "../newfold/definition";
import { solveNewfoldCaptcha } from "../newfold/submission";
import type { ProviderProxy } from "../proxy";
import { TENCENT_PROVIDER } from "../tencent/definition";
import { solveTencentCaptcha } from "../tencent/submission";
import { TUCOWS_PROVIDER } from "../tucows/definition";
import { solveTucowsCaptcha } from "../tucows/submission";
import { captchaCredentialsProblem } from "./captcha";

const PROXY: ProviderProxy = { url: "socks5://proxy.example:1080", browser: {} as ProviderProxy["browser"], captchaType: "SOCKS5" };

/** What each provider asks Death by Captcha to solve: the type, the field its parameters travel in, and the parameters. */
const REQUESTS: Array<{ name: string; solve: () => Promise<unknown>; expected: { type: string; field: string; parameters: Record<string, string> } }> = [
	{
		name: "NameSilo reCAPTCHA v2",
		solve: () => solveNameSiloCaptcha(),
		expected: { type: "4", field: "token_params", parameters: { googlekey: NAMESILO_PROVIDER.captcha.siteKey, pageurl: NAMESILO_PROVIDER.reportPageUrl } },
	},
	{
		name: "Newfold reCAPTCHA v2",
		solve: () => solveNewfoldCaptcha(undefined),
		expected: { type: "4", field: "token_params", parameters: { googlekey: NEWFOLD_PROVIDER.captcha.siteKey, pageurl: NEWFOLD_PROVIDER.captcha.pageUrl } },
	},
	{
		name: "Google Cloud reCAPTCHA v2",
		solve: () => solveGoogleCloudCaptcha(),
		expected: { type: "4", field: "token_params", parameters: { googlekey: GOOGLE_CLOUD_PROVIDER.captcha.siteKey, pageurl: GOOGLE_CLOUD_PROVIDER.reportPageUrl } },
	},
	{
		name: "Tucows Turnstile",
		solve: () => solveTucowsCaptcha(),
		expected: { type: "12", field: "turnstile_params", parameters: { sitekey: TUCOWS_PROVIDER.captcha.siteKey, pageurl: TUCOWS_PROVIDER.captcha.pageUrl } },
	},
	{
		name: "Tencent token captcha through the proxy",
		solve: () => solveTencentCaptcha(PROXY),
		expected: {
			type: "23",
			field: "tencent_params",
			parameters: { proxy: PROXY.url, proxytype: "SOCKS5", appid: TENCENT_PROVIDER.captcha.appId, pageurl: TENCENT_PROVIDER.reportPageUrl },
		},
	},
];

describe("captcha solver requests", () => {
	const saved = { username: process.env.DEATHBYCAPTCHA_USERNAME, password: process.env.DEATHBYCAPTCHA_PASSWORD };
	let requests: Array<{ url: string; form: FormData }>;
	beforeEach(() => {
		process.env.DEATHBYCAPTCHA_USERNAME = "test-user";
		process.env.DEATHBYCAPTCHA_PASSWORD = "test-password";
		requests = [];
		// The first request is the one that names the captcha; refusing it ends the solve.
		spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
			requests.push({ url: String(url), form: init.body as FormData });
			return new Response("denied", { status: 403 });
		}) as unknown as typeof fetch);
	});
	afterEach(() => {
		for (const [name, value] of [["DEATHBYCAPTCHA_USERNAME", saved.username], ["DEATHBYCAPTCHA_PASSWORD", saved.password]] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		(globalThis.fetch as unknown as { mockRestore(): void }).mockRestore();
	});

	for (const { name, solve, expected } of REQUESTS) {
		test(`${name} asks for type ${expected.type} with ${expected.field}`, async () => {
			await expect(solve()).rejects.toThrow("Death by Captcha request failed with HTTP 403");
			expect(requests).toHaveLength(1);
			const { form } = requests[0]!;
			expect(form.get("type")).toBe(expected.type);
			expect(JSON.parse(String(form.get(expected.field)))).toEqual(expected.parameters);
			expect(form.get("username")).toBe("test-user");
			// No parameter travels under another provider's field name.
			for (const other of ["token_params", "turnstile_params", "tencent_params"]) if (other !== expected.field) expect(form.get(other)).toBeNull();
		});
	}
});

describe("captchaCredentialsProblem", () => {
	test("names the unusable credentials, or nothing when the service can be paid", () => {
		const saved = { username: process.env.DEATHBYCAPTCHA_USERNAME, password: process.env.DEATHBYCAPTCHA_PASSWORD };
		try {
			process.env.DEATHBYCAPTCHA_USERNAME = "user";
			process.env.DEATHBYCAPTCHA_PASSWORD = "secret";
			expect(captchaCredentialsProblem()).toBeUndefined();
			delete process.env.DEATHBYCAPTCHA_PASSWORD;
			expect(captchaCredentialsProblem()).toContain("DEATHBYCAPTCHA");
		} finally {
			for (const [name, value] of [["DEATHBYCAPTCHA_USERNAME", saved.username], ["DEATHBYCAPTCHA_PASSWORD", saved.password]] as const) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});
});
