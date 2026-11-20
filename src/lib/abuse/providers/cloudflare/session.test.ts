import { describe, expect, test } from "bun:test";

import {
	buildCloudflareSession,
	CLOUDFLARE_DEFAULT_SESSION_TTL_MS,
	CLOUDFLARE_LOGIN_TIMEOUT_MS,
	CLOUDFLARE_SESSION_SAFETY_MS,
	loginWithContext,
	parseAtokExpiry,
	type CloudflareLoginConfig,
} from "./session";
import { ProviderLoginError } from "../login_session/session";

const config: CloudflareLoginConfig = { accountId: "acct", email: "Me@Example.test", password: "hunter2-secret" };
const T0 = 1_800_000_000_000;

describe("parseAtokExpiry", () => {
	test("reads second and millisecond timestamp prefixes", () => {
		expect(parseAtokExpiry("1800000000-abc")).toBe(1_800_000_000_000);
		expect(parseAtokExpiry("1800000000123:xyz")).toBe(1_800_000_000_123);
	});
	test("rejects non-timestamp prefixes", () => {
		expect(parseAtokExpiry("abc123")).toBeUndefined();
		expect(parseAtokExpiry("12345-abc")).toBeUndefined();
		expect(parseAtokExpiry("18000000001-abc")).toBeUndefined();
	});
});

describe("buildCloudflareSession", () => {
	test("uses the explicit atok expiry", () => {
		expect(buildCloudflareSession("1800003600-x", "v", T0).expiresAt).toBe(1_800_003_600_000);
	});
	test("rejects an explicitly expired or nearly expired prefix instead of granting a fresh TTL", () => {
		expect(() => buildCloudflareSession("1700000000-x", "v", T0)).toThrow("expired");
		expect(() => buildCloudflareSession(`${(T0 + CLOUDFLARE_SESSION_SAFETY_MS) / 1000}-x`, "v", T0)).toThrow("expired");
	});
	test("falls back to a conservative TTL for an unparseable prefix", () => {
		expect(buildCloudflareSession("opaque-token", "v", T0).expiresAt).toBe(T0 + CLOUDFLARE_DEFAULT_SESSION_TTL_MS);
	});
});

type Call = [string, ...unknown[]];
type FakeRequest = { url(): string; headers(): Record<string, string>; allHeaders(): Promise<Record<string, string>> };

type FakeResponse = { url(): string; status(): number; request(): { method(): string } };

function fakeContext(options: { atok?: string; vses2?: string; failOn?: string; extraRequests?: FakeRequest[]; allHeadersOnly?: boolean; signInStatus?: number; hangOn?: string } = {}) {
	const calls: Call[] = [];
	let requestHandler: ((request: FakeRequest) => void) | undefined;
	let responseHandler: ((response: FakeResponse) => void) | undefined;
	let closed = false;
	const hang = (name: string) => options.hangOn === name ? new Promise<never>(() => undefined) : undefined;
	const page = {
		on: (event: string, handler: never) => {
			if (event === "request") requestHandler = handler;
			if (event === "response") responseHandler = handler;
		},
		goto: async (url: string) => {
			calls.push(["goto", url]);
			if (options.failOn === "goto") throw new Error("nav failed with hunter2-secret");
			if (url.endsWith("/")) {
				for (const extra of options.extraRequests ?? []) requestHandler?.(extra);
				if (options.atok) {
					const headers = { "x-atok": options.atok };
					requestHandler?.({
						url: () => "https://dash.cloudflare.com/api/v4/user",
						headers: () => (options.allHeadersOnly ? {} : headers),
						allHeaders: async () => headers,
					});
				}
			}
		},
		evaluate: async () => { calls.push(["evaluate"]); },
		fill: async (selector: string, value: string) => { calls.push(["fill", selector, value]); },
		waitForFunction: async () => { calls.push(["waitForFunction"]); await hang("waitForFunction"); },
		click: async (selector: string) => {
			calls.push(["click", selector]);
			// The sign-in POST answers; a refused one leaves the page on /login.
			responseHandler?.({ url: () => "https://dash.cloudflare.com/api/v4/login", status: () => options.signInStatus ?? 200, request: () => ({ method: () => "POST" }) });
			if (options.signInStatus && options.signInStatus >= 400) throw new Error("Timeout 120000ms exceeded waiting for hunter2-secret");
		},
		waitForURL: async () => { calls.push(["waitForURL"]); },
		waitForTimeout: async () => { await new Promise((r) => setTimeout(r, 1)); },
		close: async () => { closed = true; },
	};
	const context = {
		newPage: async () => page,
		cookies: async () => (options.vses2 ? [{ name: "vses2", value: options.vses2 }, { name: "other", value: "x" }] : []),
	};
	return { context: context as any, calls, isClosed: () => closed };
}

describe("loginWithContext", () => {
	test("follows the login flow in order and captures atok + vses2", async () => {
		const f = fakeContext({ atok: "1800003600-token", vses2: "cookie-value" });
		const result = await loginWithContext(f.context, config, new AbortController().signal, () => T0);
		expect(result).toEqual({ id: "1800003600-token", atok: "1800003600-token", vses2: "cookie-value", expiresAt: 1_800_003_600_000 });
		const names = f.calls.map((c) => c[0]);
		expect(names.indexOf("goto")).toBeLessThan(names.indexOf("fill"));
		expect(names.indexOf("waitForFunction")).toBeLessThan(names.indexOf("click"));
		expect(names.indexOf("click")).toBeLessThan(names.indexOf("waitForURL"));
		expect(f.calls.filter((c) => c[0] === "goto").map((c) => c[1])).toEqual([
			"https://dash.cloudflare.com/login",
			"https://dash.cloudflare.com/",
		]);
		expect(f.calls).toContainEqual(["fill", 'input[name="email"]', config.email]);
		expect(f.calls).toContainEqual(["fill", 'input[name="password"]', config.password]);
		expect(f.calls).toContainEqual(["click", 'button[name="login-submit-button"]']);
		expect(f.isClosed()).toBe(true);
	});

	test("removes the consent banner locally", async () => {
		const f = fakeContext({ atok: "1800003600-token", vses2: "v" });
		await loginWithContext(f.context, config, new AbortController().signal, () => T0);
		expect(f.calls.filter((c) => c[0] === "evaluate").length).toBe(2);
	});

	test("ignores x-atok headers from other origins", async () => {
		const foreign: FakeRequest = {
			url: () => "https://evil.example/collect",
			headers: () => ({ "x-atok": "1800003600-foreign" }),
			allHeaders: async () => ({ "x-atok": "1800003600-foreign" }),
		};
		const http: FakeRequest = { ...foreign, url: () => "http://dash.cloudflare.com/x" };
		const lookalike: FakeRequest = { ...foreign, url: () => "https://dash.cloudflare.com.evil.example/x" };
		const f = fakeContext({ atok: "1800007200-real", vses2: "v", extraRequests: [foreign, http, lookalike] });
		const result = await loginWithContext(f.context, config, new AbortController().signal, () => T0);
		expect(result.atok).toBe("1800007200-real");
	});

	test("reads x-atok from allHeaders when the plain headers omit it", async () => {
		const f = fakeContext({ atok: "1800003600-extra", vses2: "v", allHeadersOnly: true });
		const result = await loginWithContext(f.context, config, new AbortController().signal, () => T0);
		expect(result.atok).toBe("1800003600-extra");
	});

	test("names an already expired atok as the step that failed", async () => {
		const f = fakeContext({ atok: "1700000000-old", vses2: "v" });
		await expect(loginWithContext(f.context, config, new AbortController().signal, () => T0)).rejects.toThrow("Cloudflare dashboard login failed: Cloudflare issued an already expired session.");
	});

	test("the overall deadline bounds waiting for x-atok", async () => {
		const f = fakeContext({ vses2: "v" });
		let time = T0;
		const err = await loginWithContext(f.context, config, new AbortController().signal, () => (time += 40_000)).catch((e: Error) => e);
		expect(err).toBeInstanceOf(ProviderLoginError);
		expect((err as Error).message).toBe("Cloudflare dashboard login failed: the dashboard issued no session token.");
		expect(f.isClosed()).toBe(true);
	});

	test("names the missing session cookie's step", async () => {
		const f = fakeContext({ atok: "1800000000-token" });
		await expect(loginWithContext(f.context, config, new AbortController().signal, () => T0)).rejects.toThrow("Cloudflare dashboard login failed: the dashboard issued no session token.");
		expect(f.isClosed()).toBe(true);
	});

	test("says Cloudflare refused the sign-in, with its status and nothing the browser said", async () => {
		const f = fakeContext({ signInStatus: 403 });
		const err = await loginWithContext(f.context, config, new AbortController().signal, () => T0).catch((e: Error) => e);
		expect((err as Error).message).toBe("Cloudflare dashboard login failed: Cloudflare refused the sign-in (HTTP 403).");
		expect((err as Error).message).not.toContain("hunter2");
	});

	test("names the step the login deadline stopped, rather than reporting a cancel", async () => {
		// A Turnstile that never issues a token runs into the 120 s bound.
		const f = fakeContext({ hangOn: "waitForFunction" });
		const controller = new AbortController();
		setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), 5);
		const err = await loginWithContext(f.context, config, controller.signal, () => T0).catch((e: Error) => e);
		expect(err).toBeInstanceOf(ProviderLoginError);
		expect((err as Error).message).toBe(`Cloudflare dashboard login failed: Cloudflare's Turnstile challenge issued no token within ${CLOUDFLARE_LOGIN_TIMEOUT_MS / 1000} s.`);
		expect(f.isClosed()).toBe(true);
	});

	test("does not leak credentials from browser errors", async () => {
		const f = fakeContext({ failOn: "goto" });
		const err = await loginWithContext(f.context, config, new AbortController().signal, () => T0).catch((e: Error) => e);
		expect((err as Error).message).toBe("Cloudflare dashboard login failed: the login page did not load.");
		expect((err as Error).message).not.toContain("hunter2");
		expect(f.isClosed()).toBe(true);
	});

	test("an aborted signal cancels instead of reporting a login failure", async () => {
		const f = fakeContext({ atok: "t", vses2: "v" });
		const controller = new AbortController();
		controller.abort();
		const err = await loginWithContext(f.context, config, controller.signal, () => T0).catch((e: Error) => e);
		expect((err as Error).name).toBe("OperationCanceledError");
	});
});
