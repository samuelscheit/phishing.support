import { createHash, randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "patchright";

import { acquireFabricPatchrightSession } from "../../../browser/fabric";
import { releaseLock, tryAcquireLock } from "../../persistence/locks";
import { OperationCanceledError, raceAbort, throwIfOperationCanceled } from "../../worker/cancellation";
import { sqliteCloudflareSessionStore, type CloudflareSession, type CloudflareSessionStore } from "./session-store";

export type { CloudflareSession } from "./session-store";

export type CloudflareLoginConfig = { accountId: string; email: string; password: string };

export const CLOUDFLARE_DASHBOARD_URL = "https://dash.cloudflare.com";
export const CLOUDFLARE_LOGIN_TIMEOUT_MS = 120_000;
export const CLOUDFLARE_LOGIN_FAILURE_TTL_MS = 30_000;
/** Conservative lifetime when x-atok carries no parseable timestamp prefix. */
export const CLOUDFLARE_DEFAULT_SESSION_TTL_MS = 5 * 60_000;
/** Upper bound for releasing the page and browser lease after a login. */
export const CLOUDFLARE_CLEANUP_TIMEOUT_MS = 10_000;
const DASHBOARD_HOST = "dash.cloudflare.com";
/** Treat a session as expired slightly early so a request never races expiry. */
export const CLOUDFLARE_SESSION_SAFETY_MS = 60_000;
const LOCK_LEASE_MS = CLOUDFLARE_LOGIN_TIMEOUT_MS + 30_000;
const LOCK_POLL_MS = 1_000;
const loginErrorMessage = "Cloudflare dashboard login failed.";

export type CloudflareSessionOptions = { signal?: AbortSignal; expiredSession?: CloudflareSession };

export type CloudflareLoginFn = (config: CloudflareLoginConfig, signal: AbortSignal) => Promise<CloudflareSession>;

export type CloudflareSessionDeps = {
	store: CloudflareSessionStore;
	login: CloudflareLoginFn;
	tryAcquireLock: (key: string, owner: string, leaseMs: number) => Promise<boolean>;
	releaseLock: (key: string, owner: string) => Promise<void>;
	now: () => number;
	sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	lockWaitMs: number;
};

/**
 * Derive the expiry from the x-atok timestamp prefix (10-digit seconds or
 * 13-digit milliseconds since epoch). Returns undefined when unparseable.
 */
export function parseAtokExpiry(atok: string): number | undefined {
	const match = /^(\d{13}|\d{10})(?!\d)/.exec(atok.trim());
	if (!match) return undefined;
	const value = Number(match[1]);
	return match[1].length === 10 ? value * 1000 : value;
}

/** An explicit, already-expired x-atok prefix is rejected, never replaced by a fresh TTL. */
export function buildCloudflareSession(atok: string, vses2: string, now: number): CloudflareSession {
	const parsed = parseAtokExpiry(atok);
	if (parsed !== undefined && parsed - CLOUDFLARE_SESSION_SAFETY_MS <= now) throw new Error("Cloudflare issued an already expired session.");
	return { atok, vses2, expiresAt: parsed ?? now + CLOUDFLARE_DEFAULT_SESSION_TTL_MS };
}

/** Remove the OneTrust dialog, which can sit above the login form and challenge frame. */
async function dismissConsentBanner(page: Page): Promise<void> {
	await page.evaluate(() => {
		document.querySelector("#onetrust-consent-sdk")?.remove();
	}).catch(() => undefined);
}

/** Resolve after `ms` even if `operation` never settles; used to bound cleanup. */
async function boundedCleanup(operation: Promise<unknown>, ms = CLOUDFLARE_CLEANUP_TIMEOUT_MS): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		operation.catch(() => undefined),
		new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
	]);
	clearTimeout(timer);
}

function isDashboardUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.hostname === DASHBOARD_HOST;
	} catch {
		return false;
	}
}

function isUsable(session: CloudflareSession | undefined, now: number): session is CloudflareSession {
	return Boolean(session && session.atok && session.vses2 && session.expiresAt - CLOUDFLARE_SESSION_SAFETY_MS > now);
}

/** Cache and lock keys are hashed so neither the email nor password is persisted as a key. */
export function cloudflareSessionKey(config: CloudflareLoginConfig): string {
	return createHash("sha256").update(`${config.accountId}\0${config.email.toLowerCase()}`).digest("hex").slice(0, 32);
}

/** Drive the dashboard login form, then capture x-atok from dashboard requests and the vses2 cookie. */
export async function loginWithContext(
	context: BrowserContext,
	config: CloudflareLoginConfig,
	signal: AbortSignal,
	clock: () => number = Date.now,
): Promise<CloudflareSession> {
	const canceled = "Cloudflare dashboard login was canceled.";
	const step = <T>(operation: Promise<T>) => raceAbort(operation, signal, undefined, canceled);
	// One deadline bounds the whole login; each browser call gets the remainder.
	const deadline = clock() + CLOUDFLARE_LOGIN_TIMEOUT_MS;
	const remaining = () => Math.max(1, deadline - clock());
	const page: Page = await step(context.newPage());
	let atok: string | undefined;
	page.on("request", (request) => {
		if (!isDashboardUrl(request.url())) return;
		const direct = request.headers()["x-atok"];
		if (direct) {
			atok = direct;
			return;
		}
		// Browser-added headers are only visible through allHeaders().
		void request.allHeaders().then((headers) => { if (headers["x-atok"]) atok = headers["x-atok"]; }, () => undefined);
	});
	try {
		await step(page.goto(`${CLOUDFLARE_DASHBOARD_URL}/login`, { waitUntil: "domcontentloaded", timeout: remaining() }));
		await step(dismissConsentBanner(page));
		await step(page.fill('input[name="email"]', config.email, { timeout: remaining() }));
		await step(page.fill('input[name="password"]', config.password, { timeout: remaining() }));
		await step(page.waitForFunction(
			() => (document.querySelector<HTMLInputElement>('[name="cf_challenge_response"]')?.value.length ?? 0) > 20,
			undefined,
			{ timeout: remaining() },
		));
		await step(dismissConsentBanner(page));
		await step(page.click('button[name="login-submit-button"]', { timeout: remaining() }));
		await step(page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: remaining() }));
		await step(page.goto(`${CLOUDFLARE_DASHBOARD_URL}/`, { waitUntil: "domcontentloaded", timeout: remaining() }));
		while (!atok && clock() < deadline) await step(page.waitForTimeout(250));
		const cookies = await step(context.cookies(CLOUDFLARE_DASHBOARD_URL));
		const vses2 = cookies.find((cookie) => cookie.name === "vses2")?.value;
		if (!atok || !vses2) throw new Error("missing session");
		return buildCloudflareSession(atok, vses2, clock());
	} catch (error) {
		if (error instanceof OperationCanceledError) throw error;
		// Browser errors can echo typed values or tokens; surface only a generic message.
		throw new Error(loginErrorMessage);
	} finally {
		await boundedCleanup(page.close());
	}
}

async function loginWithFabric(config: CloudflareLoginConfig, signal: AbortSignal): Promise<CloudflareSession> {
	const launch = acquireFabricPatchrightSession({ operation: "cloudflare-dashboard-login" }, { egress: "reporting", leaseMode: "clone" });
	const fabric = await raceAbort(launch, signal, () => {
		void launch.then((late) => late.cancel().catch(() => undefined)).catch(() => undefined);
	}, "Cloudflare dashboard login was canceled.");
	try {
		return await loginWithContext(fabric.context as BrowserContext, config, signal);
	} finally {
		await boundedCleanup(fabric.release());
	}
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const canceled = () => new OperationCanceledError("Cloudflare session wait was canceled.");
		if (signal.aborted) return reject(canceled());
		const onAbort = () => { clearTimeout(timer); reject(canceled()); };
		const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

const defaultDeps: CloudflareSessionDeps = {
	store: sqliteCloudflareSessionStore,
	login: loginWithFabric,
	tryAcquireLock,
	releaseLock,
	now: Date.now,
	sleep: defaultSleep,
	lockWaitMs: CLOUDFLARE_LOGIN_TIMEOUT_MS,
};

const inflight = new Map<string, Promise<CloudflareSession>>();

/**
 * Return a valid dashboard session: cached when usable, otherwise one login
 * (single flight in-process and across processes via abuse_locks) persisted
 * for reuse. When `expiredSession` matches the cached token, the cache is
 * invalidated and exactly one relogin happens; if another caller already
 * refreshed it, that fresh session is returned instead.
 */
export async function getCloudflareSession(
	config: CloudflareLoginConfig,
	options: CloudflareSessionOptions = {},
	overrides: Partial<CloudflareSessionDeps> = {},
): Promise<CloudflareSession> {
	const deps = { ...defaultDeps, ...overrides };
	const key = cloudflareSessionKey(config);
	throwIfOperationCanceled(options.signal, "Cloudflare session request was canceled.");

	const cached = await deps.store.read(key);
	if (isUsable(cached.session, deps.now()) && cached.session.atok !== options.expiredSession?.atok) return cached.session;

	// Callers share one flight but each keeps its own abort signal.
	const flightKey = `${key}:${options.expiredSession?.atok ?? ""}`;
	let flight = inflight.get(flightKey);
	if (!flight) {
		flight = refreshSession(config, key, options.expiredSession, deps).finally(() => inflight.delete(flightKey));
		inflight.set(flightKey, flight);
	}
	return raceAbort(flight, options.signal, undefined, "Cloudflare session request was canceled.");
}

async function refreshSession(
	config: CloudflareLoginConfig,
	key: string,
	expired: CloudflareSession | undefined,
	deps: CloudflareSessionDeps,
): Promise<CloudflareSession> {
	const lockKey = `cloudflare-dashboard-login:${key}`;
	const owner = `cloudflare-session:${process.pid}:${randomUUID()}`;
	const waitDeadline = deps.now() + deps.lockWaitMs;
	const waitSignal = AbortSignal.timeout(deps.lockWaitMs);

	/** Fresh session or recent failure written by another process, if any. */
	const settled = async (): Promise<CloudflareSession | undefined> => {
		const record = await deps.store.read(key);
		if (isUsable(record.session, deps.now()) && record.session.atok !== expired?.atok) return record.session;
		if (record.failure && record.failure.until > deps.now()) throw new Error(record.failure.message);
		return undefined;
	};

	for (;;) {
		const existing = await settled();
		if (existing) return existing;
		if (await deps.tryAcquireLock(lockKey, owner, LOCK_LEASE_MS)) break;
		if (deps.now() >= waitDeadline) throw new Error("Timed out waiting for another Cloudflare dashboard login.");
		await deps.sleep(LOCK_POLL_MS, waitSignal).catch((error) => {
			if (waitSignal.aborted) return;
			throw error;
		});
	}

	try {
		const existing = await settled();
		if (existing) return existing;
		await deps.store.clear(key);
		try {
			const session = await deps.login(config, AbortSignal.timeout(CLOUDFLARE_LOGIN_TIMEOUT_MS));
			await deps.store.writeSession(key, session);
			return session;
		} catch (error) {
			// The login signal only fires on the 120s bound, so a cancel here is a timeout failure.
			const failure = { message: loginErrorMessage, until: deps.now() + CLOUDFLARE_LOGIN_FAILURE_TTL_MS };
			await deps.store.writeFailure(key, failure).catch(() => undefined);
			throw new Error(failure.message);
		}
	} finally {
		await deps.releaseLock(lockKey, owner).catch(() => undefined);
	}
}
