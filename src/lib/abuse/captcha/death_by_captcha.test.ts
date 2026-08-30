import { describe, expect, test } from "bun:test";

import { solveDeathByCaptchaToken } from "./death_by_captcha";

describe("Death by Captcha token transport", () => {
	test("submits the provider parameters and polls until a correct token is ready", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const pauses: number[] = [];
		const responses = [
			new Response(JSON.stringify({ captcha: 1234 })),
			new Response(JSON.stringify({ captcha: 1234, text: "solved-token", is_correct: true })),
		];
		const token = await solveDeathByCaptchaToken({
			type: 12,
			parametersField: "turnstile_params",
			parameters: { sitekey: "site-key", pageurl: "https://example.test/form", proxytype: "HTTP" },
			credentials: { username: "solver", password: "secret" },
			fetch: async (url, init) => {
				requests.push({ url: String(url), init });
				return responses.shift()!;
			},
			sleep: async (milliseconds) => {
				pauses.push(milliseconds);
			},
			now: () => 0,
		});

		expect(token).toBe("solved-token");
		expect(requests.map((request) => request.url)).toEqual([
			"https://api.dbcapi.me/api/captcha",
			"https://api.dbcapi.me/api/captcha/1234",
		]);
		expect(requests[0]?.init?.method).toBe("POST");
		const body = requests[0]?.init?.body as FormData;
		expect(body.get("username")).toBe("solver");
		expect(body.get("password")).toBe("secret");
		expect(body.get("type")).toBe("12");
		expect(body.get("turnstile_params")).toBe(JSON.stringify({ sitekey: "site-key", pageurl: "https://example.test/form", proxytype: "HTTP" }));
		expect(pauses).toEqual([1_000]);
	});

	test("fails closed for malformed, rejected, and incorrect solver responses", async () => {
		const run = (response: Response) => solveDeathByCaptchaToken({
			type: 12,
			parametersField: "turnstile_params",
			parameters: {},
			credentials: { username: "solver", password: "secret" },
			fetch: async () => response,
			sleep: async () => {},
			now: () => 0,
		});

		await expect(run(new Response("not json"))).rejects.toThrow("malformed JSON");
		await expect(run(new Response(JSON.stringify({ error: "insufficient-funds" })))).rejects.toThrow("rejected the request");
		await expect(solveDeathByCaptchaToken({
			type: 12,
			parametersField: "turnstile_params",
			parameters: {},
			credentials: { username: "solver", password: "secret" },
			fetch: async () => new Response(JSON.stringify({ captcha: 1234, text: "bad", is_correct: false })),
			sleep: async () => {},
			now: () => 0,
		})).rejects.toThrow("rejected the solved token");
	});

	test("requires configured credentials before making a request", async () => {
		let calls = 0;
		await expect(solveDeathByCaptchaToken({
			type: 12,
			parametersField: "turnstile_params",
			parameters: {},
			credentials: { username: "", password: "" },
			fetch: async () => {
				calls += 1;
				return new Response("{}");
			},
		})).rejects.toThrow("DEATHBYCAPTCHA_USERNAME and DEATHBYCAPTCHA_PASSWORD");
		expect(calls).toBe(0);
	});

	test("bounds polling when the solver never returns a token", async () => {
		let now = 0;
		let polls = 0;
		await expect(solveDeathByCaptchaToken({
			type: 12,
			parametersField: "turnstile_params",
			parameters: {},
			credentials: { username: "solver", password: "secret" },
			fetch: async () => {
				polls += 1;
				return new Response(JSON.stringify({ captcha: 99 }));
			},
			sleep: async (milliseconds) => { now += milliseconds; },
			now: () => now,
			timeoutMs: 2_500,
		})).rejects.toThrow("token solving timed out");
		expect(polls).toBeGreaterThan(1);
		expect(polls).toBeLessThan(10);
	});
});
