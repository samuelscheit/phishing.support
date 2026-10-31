import { describe, expect, test } from "bun:test";

import { NAMESILO_PROVIDER } from "./definition";
import { solveNameSiloCaptcha } from "./captcha";

describe("NameSilo CAPTCHA solver", () => {
	test("uses Death by Captcha's type-4 reCAPTCHA v2 token protocol", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const responses = [
			new Response(JSON.stringify({ captcha: 42 })),
			new Response(JSON.stringify({ captcha: 42, text: "solved-token", is_correct: true })),
		];
		const token = await solveNameSiloCaptcha({
			credentials: { username: "user", password: "password" },
			fetch: async (input, init) => {
				requests.push({ url: String(input), init });
				return responses.shift()!;
			},
			sleep: async () => undefined,
			now: () => 0,
		});

		expect(token).toBe("solved-token");
		expect(requests.map((request) => request.url)).toEqual([
			"https://api.dbcapi.me/api/captcha",
			"https://api.dbcapi.me/api/captcha/42",
		]);
		const body = requests[0]?.init?.body as FormData;
		expect(body.get("type")).toBe("4");
		expect(JSON.parse(String(body.get("token_params")))).toEqual({
			googlekey: NAMESILO_PROVIDER.captcha.siteKey,
			pageurl: NAMESILO_PROVIDER.reportPageUrl,
		});
	});

	test("rejects missing solver credentials before making a request", async () => {
		await expect(solveNameSiloCaptcha({ credentials: { username: "", password: "" } }))
			.rejects.toThrow("NameSilo phishing reporting requires DEATHBYCAPTCHA_USERNAME");
	});
});
