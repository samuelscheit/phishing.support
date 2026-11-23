import { describe, expect, test } from "bun:test";

import type { BrowserContext } from "patchright";

import {
	boundedCleanup,
	createLoginSessions,
	ProviderLoginError,
	ProviderLoginUnavailableError,
	withLoginBrowser,
	type LoginBrowserSession,
	type LoginSession,
	type LoginSessionDeps,
	type LoginSessionSpec,
} from "./session";
import { createMemoryLoginSessionStore } from "./store";
import { OperationCanceledError } from "../../worker/cancellation";
import { BrowserUnavailableError, isBrowserUnavailable } from "../../../browser/fabric";

type Config = { account: string };
type Fake = LoginSession & { secret: string };

const config: Config = { account: "Me@Example.test" };
const T0 = 1_800_000_000_000;
const SAFETY = 60_000;
const FAILURE_TTL = 10 * 60_000;

function session(id: string, expiresAt = T0 + 3_600_000): Fake {
	return { id, secret: `secret-${id}`, expiresAt };
}

function harness(login?: (config: Config, signal: AbortSignal) => Promise<Fake>) {
	const store = createMemoryLoginSessionStore();
	const locks = new Map<string, string>();
	const state = { time: T0, logins: 0 };
	const spec: LoginSessionSpec<Config, Fake> = {
		provider: "Fake",
		namespace: "fake",
		account: (c) => c.account.toLowerCase(),
		login: login ?? (async () => { state.logins += 1; return session(`new${state.logins}`); }),
		parse: (value) => (value as Fake | null)?.id ? (value as Fake) : undefined,
		loginTimeoutMs: 120_000,
		failureTtlMs: FAILURE_TTL,
		safetyMs: SAFETY,
	};
	const deps: Partial<LoginSessionDeps> = {
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
	};
	const sessions = createLoginSessions(spec, deps);
	const key = sessions.key(config);
	return { store, locks, state, deps, spec, sessions, key, lockKey: `fake-login:${key}` };
}

describe("createLoginSessions", () => {
	test("logs in once, persists, and serves later calls from cache", async () => {
		const h = harness();
		const first = await h.sessions.get(config);
		expect(await h.sessions.get(config)).toEqual(first);
		expect(h.state.logins).toBe(1);
		expect(h.store.records.get(h.key)?.session).toEqual(first);
		expect(h.locks.size).toBe(0);
	});

	test("never uses the account name in the persisted key", () => {
		const h = harness();
		expect(h.key).not.toContain("example");
		expect(h.key.startsWith("fake:")).toBe(true);
		expect(h.sessions.key({ account: "ME@example.test" })).toBe(h.key);
	});

	test("ignores a stored session its provider cannot parse", async () => {
		const h = harness();
		h.store.records.set(h.key, { session: { nonsense: true } });
		expect((await h.sessions.get(config)).id).toBe("new1");
	});

	test("concurrent callers share a single login", async () => {
		const state = { logins: 0 };
		const h = harness(async () => { state.logins += 1; await Promise.resolve(); return session("shared"); });
		const results = await Promise.all([1, 2, 3, 4].map(() => h.sessions.get(config)));
		expect(state.logins).toBe(1);
		for (const r of results) expect(r.id).toBe("shared");
	});

	test("treats a session inside the safety window as expired", async () => {
		const h = harness();
		h.store.records.set(h.key, { session: session("old", T0 + SAFETY - 1) });
		expect((await h.sessions.get(config)).id).toBe("new1");
	});

	test("expiredSession matching the cache invalidates and relogs in exactly once", async () => {
		const h = harness();
		const old = session("old");
		h.store.records.set(h.key, { session: old });
		const results = await Promise.all([h.sessions.get(config, { expiredSession: old }), h.sessions.get(config, { expiredSession: old })]);
		expect(h.state.logins).toBe(1);
		expect(results.map((r) => r.id)).toEqual(["new1", "new1"]);
		expect((h.store.records.get(h.key)?.session as Fake).id).toBe("new1");
	});

	test("expiredSession already replaced by another caller returns the fresh session without login", async () => {
		const h = harness();
		h.store.records.set(h.key, { session: session("fresh") });
		expect((await h.sessions.get(config, { expiredSession: session("old") })).id).toBe("fresh");
		expect(h.state.logins).toBe(0);
	});

	test("waits for another process holding the lock and uses its result", async () => {
		const h = harness();
		h.locks.set(h.lockKey, "other");
		const base = h.deps.sleep!;
		let slept = 0;
		const sessions = createLoginSessions(h.spec, {
			...h.deps,
			sleep: async (ms, signal) => {
				await base(ms, signal);
				slept += 1;
				if (slept === 2) h.store.records.set(h.key, { session: session("from-other") });
			},
		});
		expect((await sessions.get(config)).id).toBe("from-other");
		expect(h.state.logins).toBe(0);
		expect(h.locks.get(h.lockKey)).toBe("other");
	});

	test("times out while waiting for a lock that never frees", async () => {
		const h = harness();
		h.locks.set(h.lockKey, "other");
		await expect(h.sessions.get(config)).rejects.toThrow("Timed out waiting for another Fake login");
		expect(h.state.logins).toBe(0);
	});

	test("records a generic failure for the backoff window, says how long to wait, and does not stampede", async () => {
		const state = { logins: 0 };
		const h = harness(async () => { state.logins += 1; throw new Error("boom token=SECRET-ATOK hunter2"); });
		const err = await h.sessions.get(config).catch((e: Error) => e);
		expect(err).toBeInstanceOf(ProviderLoginUnavailableError);
		expect((err as Error).message).toBe("Fake login failed.");
		expect((err as ProviderLoginUnavailableError).retryAfterMs).toBe(FAILURE_TTL);
		expect(JSON.stringify(h.store.records.get(h.key))).not.toContain("SECRET");
		expect(h.locks.size).toBe(0);

		h.state.time += 4 * 60_000;
		const replayed = await h.sessions.get(config).then(() => undefined, (e: unknown) => e);
		expect(replayed).toBeInstanceOf(ProviderLoginUnavailableError);
		expect((replayed as ProviderLoginUnavailableError).retryAfterMs).toBe(FAILURE_TTL - 4 * 60_000);
		expect(state.logins).toBe(1);

		h.state.time += FAILURE_TTL;
		await expect(h.sessions.get(config)).rejects.toThrow("login failed");
		expect(state.logins).toBe(2);
	});

	test("keeps the failed step for everyone the failure is replayed to", async () => {
		const state = { logins: 0 };
		const h = harness(async () => { state.logins += 1; throw new ProviderLoginError("Fake", "the challenge issued no token"); });
		const message = "Fake login failed: the challenge issued no token.";
		await expect(h.sessions.get(config)).rejects.toThrow(message);
		expect(h.store.records.get(h.key)?.failure?.message).toBe(message);
		await expect(h.sessions.get(config)).rejects.toThrow(message);
		expect(state.logins).toBe(1);
	});

	test("a login without a browser is not the account's failure: nothing is stored, the next caller logs in, and the type reaches the worker", async () => {
		const state = { logins: 0 };
		const h = harness(async () => {
			state.logins += 1;
			if (state.logins === 1) throw new ProviderLoginError("Fake", "no browser was available", { cause: new BrowserUnavailableError(new Error("503 Service Unavailable")) });
			return session("after-browser");
		});
		const error = await h.sessions.get(config).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProviderLoginError);
		expect(isBrowserUnavailable(error)).toBeTrue();
		expect(error).not.toBeInstanceOf(ProviderLoginUnavailableError);
		expect(h.store.records.get(h.key)?.failure).toBeUndefined();
		expect(h.locks.size).toBe(0);
		// No backoff window: the very next call logs in.
		expect((await h.sessions.get(config)).id).toBe("after-browser");
		expect(state.logins).toBe(2);
	});

	test("a login cut off by its own deadline is reported as a timeout failure", async () => {
		const { OperationCanceledError } = await import("../../worker/cancellation");
		const h = harness(async () => { throw new OperationCanceledError("x"); });
		await expect(h.sessions.get(config)).rejects.toThrow("Fake login failed: the login did not finish within 120 s.");
	});

	test("a successful login clears a prior failure", async () => {
		const h = harness();
		h.store.records.set(h.key, { failure: { message: "Fake login failed.", until: T0 - 1 } });
		await h.sessions.get(config);
		expect(h.store.records.get(h.key)?.failure).toBeUndefined();
	});

	test("an already-aborted signal rejects before any work", async () => {
		const h = harness();
		const controller = new AbortController();
		controller.abort();
		await expect(h.sessions.get(config, { signal: controller.signal })).rejects.toThrow();
		expect(h.state.logins).toBe(0);
	});

	test("aborting one caller does not cancel the shared login for others", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const state = { logins: 0 };
		const h = harness(async () => { state.logins += 1; await gate; return session("slow"); });
		const controller = new AbortController();
		const aborted = h.sessions.get(config, { signal: controller.signal });
		const other = h.sessions.get(config);
		await new Promise((r) => setTimeout(r, 5));
		controller.abort();
		await expect(aborted).rejects.toThrow();
		release();
		expect((await other).id).toBe("slow");
		expect(state.logins).toBe(1);
	});

	test("releases the lock when login throws", async () => {
		const h = harness(async () => { throw new Error("x"); });
		await h.sessions.get(config).catch(() => undefined);
		expect(h.locks.size).toBe(0);
	});
});

describe("boundedCleanup", () => {
	test("resolves after the bound when the operation never settles", async () => {
		const started = Date.now();
		await boundedCleanup(new Promise(() => undefined), 20);
		expect(Date.now() - started).toBeLessThan(500);
	});
	test("swallows a rejection", async () => {
		await boundedCleanup(Promise.reject(new Error("x")), 1_000);
	});
});

describe("withLoginBrowser", () => {
	const fakeContext = {} as BrowserContext;

	test("passes the acquired context to run and always releases the browser", async () => {
		let released = 0;
		let operationSeen = "";
		const acquire = async (operation: string): Promise<LoginBrowserSession> => {
			operationSeen = operation;
			return { context: fakeContext, release: async () => { released += 1; }, cancel: async () => undefined };
		};
		const result = await withLoginBrowser("Fake", "fake-login", AbortSignal.timeout(5_000), async (ctx) => {
			expect(ctx).toBe(fakeContext);
			return "ok";
		}, acquire);
		expect(result).toBe("ok");
		expect(operationSeen).toBe("fake-login");
		expect(released).toBe(1);

		await expect(withLoginBrowser("Fake", "fake-login", AbortSignal.timeout(5_000), async () => {
			throw new Error("boom");
		}, acquire)).rejects.toThrow("boom");
		expect(released).toBe(2);
	});

	test("a login deadline firing during browser acquisition is classified as BrowserUnavailableError and cancels the late lease", async () => {
		let resolveLate!: (session: LoginBrowserSession) => void;
		const latePromise = new Promise<LoginBrowserSession>((resolve) => { resolveLate = resolve; });
		let canceled = 0;
		let ran = 0;
		const h = harness((_config, signal) => withLoginBrowser("Fake", "fake-login", signal, async () => {
			ran += 1;
			return session("never");
		}, () => latePromise));
		const sessions = createLoginSessions({ ...h.spec, loginTimeoutMs: 25 }, h.deps);

		const error = await sessions.get(config).catch((e: unknown) => e);
		expect(ran).toBe(0);
		expect(error).toBeInstanceOf(ProviderLoginError);
		expect(error).not.toBeInstanceOf(ProviderLoginUnavailableError);
		expect(isBrowserUnavailable(error)).toBeTrue();
		expect(h.store.records.get(h.key)?.failure).toBeUndefined();

		// A browser that finishes booting after the deadline is canceled immediately.
		resolveLate({ context: fakeContext, release: async () => undefined, cancel: async () => { canceled += 1; } });
		await new Promise((r) => setTimeout(r, 10));
		expect(canceled).toBe(1);
	});

	test("a caller-initiated abort during browser acquisition rethrows OperationCanceledError, not BrowserUnavailableError", async () => {
		const controller = new AbortController();
		let canceled = 0;
		let resolveLate!: (session: LoginBrowserSession) => void;
		const latePromise = new Promise<LoginBrowserSession>((resolve) => { resolveLate = resolve; });
		const pending = withLoginBrowser("Fake", "fake-login", controller.signal, async () => "never", () => latePromise);
		controller.abort(new Error("caller stopped"));
		const error = await pending.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(OperationCanceledError);
		expect(isBrowserUnavailable(error)).toBeFalse();

		resolveLate({ context: fakeContext, release: async () => undefined, cancel: async () => { canceled += 1; } });
		await new Promise((r) => setTimeout(r, 10));
		expect(canceled).toBe(1);
	});

	test("preserves BrowserUnavailableError cause when acquire itself rejects", async () => {
		const cause = new BrowserUnavailableError(new Error("503 Service Unavailable"));
		const error = await withLoginBrowser("Fake", "fake-login", AbortSignal.timeout(5_000), async () => "never", async () => {
			throw cause;
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProviderLoginError);
		expect(isBrowserUnavailable(error)).toBeTrue();
		expect((error as Error).cause).toBe(cause);
	});
});

