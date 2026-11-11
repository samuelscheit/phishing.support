import { createHash, randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "patchright";

import { acquireFabricPatchrightSession } from "../../../browser/fabric";
import { errorSummary } from "../../../error_text";
import { releaseLock, tryAcquireLock } from "../../persistence/locks";
import { OperationCanceledError, raceAbort, throwIfOperationCanceled } from "../../worker/cancellation";
import { sqliteCloudflareSessionStore, type CloudflareSession, type CloudflareSessionStore } from "./session-store";

export type { CloudflareSession } from "./session-store";

export type CloudflareLoginConfig = { accountId: string; email: string; password: string };

export const CLOUDFLARE_DASHBOARD_URL = "https://dash.cloudflare.com";
export const CLOUDFLARE_LOGIN_TIMEOUT_MS = 120_000;
/**
 * After a failed login nobody logs in again for this long; every caller in
 * that window gets the failure, with the time left to wait. Each real login
 * risks the account's lockout, and a login that just failed (a Turnstile
 * Cloudflare would not pass, a browser service at capacity) rarely passes
 * seconds later. A shorter window let waiting jobs replay one failure until
 * their retries were spent: 195 failed jobs in an hour on 2026-11-09.
 */
export const CLOUDFLARE_LOGIN_FAILURE_TTL_MS = 10 * 60_000;
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

/** A login that failed at a named step. The message never carries browser error text, which can echo typed values. */
export class CloudflareLoginError extends Error {
	constructor(readonly stage: string) {
		super(`${loginErrorMessage.slice(0, -1)}: ${stage}.`);
		this.name = "CloudflareLoginError";
	}
}

/** No session for now: the last login failed, and the next may be tried in `retryAfterMs`. */
export class CloudflareLoginUnavailableError extends Error {
	constructor(message: string, readonly retryAfterMs: number) {
		super(message);
		this.name = "CloudflareLoginUnavailableError";
	}
}

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
	let loginStatus: number | undefined;
	page.on("response", (response) => {
		const url = new URL(response.url());
		if (url.hostname === DASHBOARD_HOST && url.pathname === "/api/v4/login" && response.request().method() === "POST") loginStatus = response.status();
	});
	let stage = "the login page did not load";
	try {
		await step(page.goto(`${CLOUDFLARE_DASHBOARD_URL}/login`, { waitUntil: "domcontentloaded", timeout: remaining() }));
		await step(dismissConsentBanner(page));
		stage = "the login form did not appear";
		await step(page.fill('input[name="email"]', config.email, { timeout: remaining() }));
		await step(page.fill('input[name="password"]', config.password, { timeout: remaining() }));
		stage = "Cloudflare's Turnstile challenge issued no token";
		await step(page.waitForFunction(
			() => (document.querySelector<HTMLInputElement>('[name="cf_challenge_response"]')?.value.length ?? 0) > 20,
			undefined,
			{ timeout: remaining() },
		));
		await step(dismissConsentBanner(page));
		stage = "the login button could not be pressed";
		await step(page.click('button[name="login-submit-button"]', { timeout: remaining() }));
		stage = "the dashboard did not leave the login page after sign-in";
		await step(page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: remaining() }));
		// Past sign-in, Cloudflare may show an interstitial (two-factor setup,
		// /two-factor-interstitial since 2026-11); the dashboard itself issues the session.
		stage = "the dashboard did not load after sign-in";
		await step(page.goto(`${CLOUDFLARE_DASHBOARD_URL}/`, { waitUntil: "domcontentloaded", timeout: remaining() }));
		stage = "the dashboard issued no session token";
		while (!atok && clock() < deadline) await step(page.waitForTimeout(250));
		const cookies = await step(context.cookies(CLOUDFLARE_DASHBOARD_URL));
		const vses2 = cookies.find((cookie) => cookie.name === "vses2")?.value;
		if (!atok || !vses2) throw new Error("missing session");
		stage = "Cloudflare issued an already expired session";
		return buildCloudflareSession(atok, vses2, clock());
	} catch (error) {
		// The login's own deadline names the step it stopped at; any other cancel is the caller's.
		const timedOut = signal.reason instanceof DOMException && signal.reason.name === "TimeoutError";
		if (error instanceof OperationCanceledError && !timedOut) throw error;
		// Browser errors can echo typed values or tokens; surface only the step,
		// and the sign-in answer's status when Cloudflare refused it.
		throw new CloudflareLoginError(loginStatus !== undefined && loginStatus >= 400
			? `Cloudflare refused the sign-in (HTTP ${loginStatus})`
			: `${stage}${timedOut ? ` within ${CLOUDFLARE_LOGIN_TIMEOUT_MS / 1000} s` : ""}`);
	} finally {
		await boundedCleanup(page.close());
	}
}

async function loginWithFabric(config: CloudflareLoginConfig, signal: AbortSignal): Promise<CloudflareSession> {
	const launch = acquireFabricPatchrightSession({ operation: "cloudflare-dashboard-login" }, { egress: "reporting", leaseMode: "clone" });
	const fabric = await raceAbort(launch, signal, () => {
		void launch.then((late) => late.cancel().catch(() => undefined)).catch(() => undefined);
	}, "Cloudflare dashboard login was canceled.").catch((error: unknown) => {
		if (error instanceof OperationCanceledError) throw error;
		// No credential has been typed yet; the browser service's own answer is safe to keep.
		throw new CloudflareLoginError(`no browser was available (${errorSummary(error)})`);
	});
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
		if (record.failure && record.failure.until > deps.now()) throw new CloudflareLoginUnavailableError(record.failure.message, record.failure.until - deps.now());
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
			const message = error instanceof CloudflareLoginError ? error.message
				: error instanceof OperationCanceledError ? new CloudflareLoginError(`the login did not finish within ${CLOUDFLARE_LOGIN_TIMEOUT_MS / 1000} s`).message
					: loginErrorMessage;
			const failure = { message, until: deps.now() + CLOUDFLARE_LOGIN_FAILURE_TTL_MS };
			await deps.store.writeFailure(key, failure).catch(() => undefined);
			throw new CloudflareLoginUnavailableError(failure.message, CLOUDFLARE_LOGIN_FAILURE_TTL_MS);
		}
	} finally {
		await deps.releaseLock(lockKey, owner).catch(() => undefined);
	}
}
