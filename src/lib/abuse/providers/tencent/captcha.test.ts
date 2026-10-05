import { describe, expect, test } from "bun:test";

import { parseTencentCaptchaSolution, solveTencentCaptcha, type FetchLike } from "./captcha";

describe("Tencent CAPTCHA solver", () => {
	test("validates the exact Tencent token response", () => {
		expect(parseTencentCaptchaSolution('{"ret":0,"ticket":"ticket-value","randstr":"abc"}')).toEqual({
			ret: 0,
			ticket: "ticket-value",
			randstr: "abc",
		});
		expect(() => parseTencentCaptchaSolution('{"ret":1}')).toThrow("Tencent CAPTCHA solving failed.");
		expect(() => parseTencentCaptchaSolution('{"ret":0,"ticket":"ticket-value"}')).toThrow("Tencent CAPTCHA solving failed.");
		expect(() => parseTencentCaptchaSolution("not json")).toThrow("Tencent CAPTCHA solver returned malformed JSON.");
	});

	test("uses only the type-23 token protocol and polls until a validated result arrives", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const pauses: number[] = [];
		const responses = [
			new Response(JSON.stringify({ captcha: 42 })),
			new Response(JSON.stringify({ captcha: 42, text: '{"ret":0,"ticket":"solved","randstr":"rand"}', is_correct: true })),
		];
		const request: FetchLike = async (url, init) => {
			requests.push({ url: String(url), init });
			return responses.shift()!;
		};

		const result = await solveTencentCaptcha(
			{ url: "socks5://proxy.example:1080", browser: { server: "socks5://proxy.example:1080" }, captchaType: "SOCKS5" },
			{
				credentials: { username: "user", password: "password" },
				fetch: request,
				sleep: async (milliseconds) => {
					pauses.push(milliseconds);
				},
				now: () => 0,
			},
		);

		expect(result).toMatchObject({ ticket: "solved", randstr: "rand" });
		expect(requests.map((entry) => entry.url)).toEqual([
			"https://api.dbcapi.me/api/captcha",
			"https://api.dbcapi.me/api/captcha/42",
		]);
		expect(requests[0]?.init?.method).toBe("POST");
		expect(pauses).toEqual([1_000]);
		const body = requests[0]?.init?.body as FormData;
		expect(body.get("type")).toBe("23");
		expect(body.get("tencent_params")).toContain('"proxytype":"SOCKS5"');
	});

	test("rejects missing solver credentials before it can make a DBC request", async () => {
		await expect(solveTencentCaptcha(
			{ url: "http://proxy.example:8080", browser: { server: "http://proxy.example:8080" }, captchaType: "HTTP" },
			{ credentials: { username: "", password: "" } },
		)).rejects.toThrow("DEATHBYCAPTCHA_USERNAME and DEATHBYCAPTCHA_PASSWORD");
	});
});
