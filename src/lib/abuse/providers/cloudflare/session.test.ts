import { describe, expect, test } from "bun:test";

import {
	buildCloudflareSession,
	CLOUDFLARE_DEFAULT_SESSION_TTL_MS,
	CLOUDFLARE_LOGIN_FAILURE_TTL_MS,
	CLOUDFLARE_SESSION_SAFETY_MS,
	cloudflareSessionKey,
	getCloudflareSession,
	loginWithContext,
	parseAtokExpiry,
	type CloudflareLoginConfig,
	type CloudflareSession,
	type CloudflareSessionDeps,
} from "./session";
import { createMemoryCloudflareSessionStore } from "./session-store";

const config: CloudflareLoginConfig = { accountId: "acct", email: "Me@Example.test", password: "hunter2-secret" };
const key = cloudflareSessionKey(config);
const T0 = 1_800_000_000_000;

function session(atok: string, expiresAt = T0 + 3_600_000): CloudflareSession {
	return { atok, vses2: `vses-${atok}`, expiresAt };
}

function harness(overrides: Partial<CloudflareSessionDeps> = {}) {
	const store = createMemoryCloudflareSessionStore();
	const locks = new Map<string, string>();
	const state = { time: T0, logins: 0 };
	const deps: Partial<CloudflareSessionDeps> = {
		store,
		now: () => state.time,
		sleep: async (ms) => { state.time += ms; },
		tryAcquireLock: async (lockKey, owner) => {
			if (locks.has(lockKey)) return false;
			locks.set(lockKey, owner);
			return true;
		},
		releaseLock: async (lockKey, owner) => { if (locks.get(lockKey) === owner) locks.delete(lockKey); },
		lockWaitMs: 5_000,
		login: async () => { state.logins += 1; return session(`new${state.logins}`); },
		...overrides,
	};
	return { store, locks, state, deps };
}

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

describe("getCloudflareSession", () => {
	test("logs in once, persists, and serves later calls from cache", async () => {
		const h = harness();
		const first = await getCloudflareSession(config, {}, h.deps);
		const second = await getCloudflareSession(config, {}, h.deps);
		expect(second).toEqual(first);
		expect(h.state.logins).toBe(1);
		expect(h.store.records.get(key)?.session).toEqual(first);
		expect(h.locks.size).toBe(0);
	});

	test("never uses credentials in the persisted key", () => {
		expect(key).not.toContain("hunter2");
		expect(key).not.toContain("example");
	});

	test("concurrent callers share a single login", async () => {
		const h = harness({ login: async () => { h.state.logins += 1; await Promise.resolve(); return session("shared"); } });
		const results = await Promise.all([1, 2, 3, 4].map(() => getCloudflareSession(config, {}, h.deps)));
		expect(h.state.logins).toBe(1);
		for (const r of results) expect(r.atok).toBe("shared");
	});

	test("treats a session inside the safety window as expired", async () => {
		const h = harness();
		h.store.records.set(key, { session: session("old", T0 + CLOUDFLARE_SESSION_SAFETY_MS - 1) });
		const result = await getCloudflareSession(config, {}, h.deps);
		expect(result.atok).toBe("new1");
	});

	test("expiredSession matching the cache invalidates and relogs in exactly once", async () => {
		const h = harness();
		const old = session("old");
		h.store.records.set(key, { session: old });
		const results = await Promise.all([
			getCloudflareSession(config, { expiredSession: old }, h.deps),
			getCloudflareSession(config, { expiredSession: old }, h.deps),
		]);
		expect(h.state.logins).toBe(1);
		expect(results.map((r) => r.atok)).toEqual(["new1", "new1"]);
		expect(h.store.records.get(key)?.session?.atok).toBe("new1");
	});

	test("expiredSession already replaced by another caller returns the fresh session without login", async () => {
		const h = harness();
		h.store.records.set(key, { session: session("fresh") });
		const result = await getCloudflareSession(config, { expiredSession: session("old") }, h.deps);
		expect(result.atok).toBe("fresh");
		expect(h.state.logins).toBe(0);
	});

	test("waits for another process holding the lock and uses its result", async () => {
		const h = harness();
		h.locks.set(`cloudflare-dashboard-login:${key}`, "other");
		const base = h.deps.sleep!;
		let slept = 0;
		h.deps.sleep = async (ms, signal) => {
			await base(ms, signal);
			slept += 1;
			if (slept === 2) h.store.records.set(key, { session: session("from-other") });
		};
		const result = await getCloudflareSession(config, {}, h.deps);
		expect(result.atok).toBe("from-other");
		expect(h.state.logins).toBe(0);
		expect(h.locks.get(`cloudflare-dashboard-login:${key}`)).toBe("other");
	});

	test("times out while waiting for a lock that never frees", async () => {
		const h = harness();
		h.locks.set(`cloudflare-dashboard-login:${key}`, "other");
		await expect(getCloudflareSession(config, {}, h.deps)).rejects.toThrow("Timed out waiting");
		expect(h.state.logins).toBe(0);
	});

	test("records a generic failure briefly and does not stampede", async () => {
		const h = harness({ login: async () => { h.state.logins += 1; throw new Error("boom token=SECRET-ATOK hunter2-secret"); } });
		const err = await getCloudflareSession(config, {}, h.deps).catch((e: Error) => e);
		expect((err as Error).message).toBe("Cloudflare dashboard login failed.");
		expect(JSON.stringify(h.store.records.get(key))).not.toContain("SECRET");
		expect(h.locks.size).toBe(0);

		await expect(getCloudflareSession(config, {}, h.deps)).rejects.toThrow("login failed");
		expect(h.state.logins).toBe(1);

		h.state.time += CLOUDFLARE_LOGIN_FAILURE_TTL_MS + 1;
		await expect(getCloudflareSession(config, {}, h.deps)).rejects.toThrow("login failed");
		expect(h.state.logins).toBe(2);
	});

	test("a successful login clears a prior failure", async () => {
		const h = harness();
		h.store.records.set(key, { failure: { message: "Cloudflare dashboard login failed.", until: T0 - 1 } });
		await getCloudflareSession(config, {}, h.deps);
		expect(h.store.records.get(key)?.failure).toBeUndefined();
	});

	test("an already-aborted signal rejects before any work", async () => {
		const h = harness();
		const controller = new AbortController();
		controller.abort();
		await expect(getCloudflareSession(config, { signal: controller.signal }, h.deps)).rejects.toThrow();
		expect(h.state.logins).toBe(0);
	});

	test("aborting one caller does not cancel the shared login for others", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const h = harness({ login: async () => { h.state.logins += 1; await gate; return session("slow"); } });
		const controller = new AbortController();
		const aborted = getCloudflareSession(config, { signal: controller.signal }, h.deps);
		const other = getCloudflareSession(config, {}, h.deps);
		await new Promise((r) => setTimeout(r, 5));
		controller.abort();
		await expect(aborted).rejects.toThrow();
		release();
		expect((await other).atok).toBe("slow");
		expect(h.state.logins).toBe(1);
	});

	test("releases the lock when login throws", async () => {
		const h = harness({ login: async () => { throw new Error("x"); } });
		await getCloudflareSession(config, {}, h.deps).catch(() => undefined);
		expect(h.locks.size).toBe(0);
	});
});

type Call = [string, ...unknown[]];
type FakeRequest = { url(): string; headers(): Record<string, string>; allHeaders(): Promise<Record<string, string>> };

function fakeContext(options: { atok?: string; vses2?: string; failOn?: string; extraRequests?: FakeRequest[]; allHeadersOnly?: boolean } = {}) {
	const calls: Call[] = [];
	let requestHandler: ((request: FakeRequest) => void) | undefined;
	let closed = false;
	const page = {
		on: (event: string, handler: typeof requestHandler) => { if (event === "request") requestHandler = handler; },
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
		waitForFunction: async () => { calls.push(["waitForFunction"]); },
		click: async (selector: string) => { calls.push(["click", selector]); },
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
		expect(result).toEqual({ atok: "1800003600-token", vses2: "cookie-value", expiresAt: 1_800_003_600_000 });
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

	test("rejects an already expired atok as a generic failure", async () => {
		const f = fakeContext({ atok: "1700000000-old", vses2: "v" });
		await expect(loginWithContext(f.context, config, new AbortController().signal, () => T0)).rejects.toThrow("Cloudflare dashboard login failed.");
	});

	test("the overall deadline bounds waiting for x-atok", async () => {
		const f = fakeContext({ vses2: "v" });
		let time = T0;
		const err = await loginWithContext(f.context, config, new AbortController().signal, () => (time += 40_000)).catch((e: Error) => e);
		expect((err as Error).message).toBe("Cloudflare dashboard login failed.");
		expect(f.isClosed()).toBe(true);
	});

	test("fails with a generic message when vses2 is missing", async () => {
		const f = fakeContext({ atok: "1800000000-token" });
		await expect(loginWithContext(f.context, config, new AbortController().signal, () => T0)).rejects.toThrow("Cloudflare dashboard login failed.");
		expect(f.isClosed()).toBe(true);
	});

	test("does not leak credentials from browser errors", async () => {
		const f = fakeContext({ failOn: "goto" });
		const err = await loginWithContext(f.context, config, new AbortController().signal, () => T0).catch((e: Error) => e);
		expect((err as Error).message).toBe("Cloudflare dashboard login failed.");
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
