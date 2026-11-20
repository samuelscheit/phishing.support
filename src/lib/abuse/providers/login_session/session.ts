import { randomUUID } from "node:crypto";

import { releaseLock, tryAcquireLock } from "../../persistence/locks";
import { OperationCanceledError, raceAbort, throwIfOperationCanceled } from "../../worker/cancellation";
import { sqliteLoginSessionStore, type LoginSessionStore } from "./store";
import { sha256Hex } from "../../../util/hash";
import { raceTimeout } from "../../../util/async";

/**
 * A logged-in provider account session: whatever a provider needs to call its
 * console (tokens, a cookie jar), stored as JSON. `id` tells two sessions
 * apart, so a caller can report the one the provider just refused.
 */
export type LoginSession = { readonly id: string; readonly expiresAt: number };

/** A login that failed at a named step. The message never carries browser error text, which can echo typed values. */
export class ProviderLoginError extends Error {
	constructor(readonly provider: string, readonly stage: string) {
		super(`${provider} login failed: ${stage}.`);
		this.name = "ProviderLoginError";
	}
}

/**
 * No session for now: the last login failed, and the next may be tried in
 * `retryAfterMs`. The worker reads `retryAfterMs` to delay the job's retry.
 */
export class ProviderLoginUnavailableError extends Error {
	constructor(message: string, readonly retryAfterMs: number) {
		super(message);
		this.name = "ProviderLoginUnavailableError";
	}
}

export type LoginSessionOptions<S extends LoginSession> = { signal?: AbortSignal; expiredSession?: S };

/** What one provider's account login is: how to log in, and how long it and its sessions last. */
export type LoginSessionSpec<C, S extends LoginSession> = {
	/** Named in errors: "Cloudflare dashboard", "Alibaba Cloud". */
	provider: string;
	/** Store and lock namespace; never changes once sessions are stored under it. */
	namespace: string;
	/** The account a config logs in to: hashed into the store key, so no login name is persisted as a key. */
	account(config: C): string;
	login(config: C, signal: AbortSignal): Promise<S>;
	/** Validates a stored session's JSON before it is used. */
	parse(value: unknown): S | undefined;
	/** Upper bound of one login; its signal fires then. */
	loginTimeoutMs: number;
	/**
	 * After a failed login nobody logs in again for this long; every caller in
	 * that window gets the failure, with the time left to wait. Each real login
	 * risks the account's lockout, and a login that just failed rarely passes
	 * seconds later. A shorter window let waiting jobs replay one failure until
	 * their retries were spent: 195 failed jobs in an hour on 2026-11-09.
	 */
	failureTtlMs: number;
	/** Treat a session as expired this much early so a request never races expiry. */
	safetyMs: number;
};

export type LoginSessionDeps = {
	store: LoginSessionStore;
	tryAcquireLock: (key: string, owner: string, leaseMs: number) => Promise<boolean>;
	releaseLock: (key: string, owner: string) => Promise<void>;
	now: () => number;
	sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	/** How long a caller waits for another process's login; default the login timeout. */
	lockWaitMs?: number;
};

const LOCK_POLL_MS = 1_000;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const canceled = () => new OperationCanceledError("Provider session wait was canceled.");
		if (signal.aborted) return reject(canceled());
		const onAbort = () => { clearTimeout(timer); reject(canceled()); };
		const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

const defaultDeps: LoginSessionDeps = { store: sqliteLoginSessionStore, tryAcquireLock, releaseLock, now: Date.now, sleep: defaultSleep };

export type LoginSessions<C, S extends LoginSession> = {
	/**
	 * A valid session: cached when usable, otherwise one login (single flight
	 * in-process and across processes via abuse_locks) persisted for reuse.
	 * When `expiredSession` is the cached one, the cache is invalidated and
	 * exactly one relogin happens; if another caller already refreshed it, that
	 * fresh session is returned instead.
	 */
	get(config: C, options?: LoginSessionOptions<S>): Promise<S>;
	/** The store key of a config's account. */
	key(config: C): string;
};

export function createLoginSessions<C, S extends LoginSession>(spec: LoginSessionSpec<C, S>, overrides: Partial<LoginSessionDeps> = {}): LoginSessions<C, S> {
	const deps = { ...defaultDeps, ...overrides };
	const lockWaitMs = deps.lockWaitMs ?? spec.loginTimeoutMs;
	const lockLeaseMs = spec.loginTimeoutMs + 30_000;
	const canceled = `${spec.provider} session request was canceled.`;
	const inflight = new Map<string, Promise<S>>();

	const key = (config: C) => `${spec.namespace}:${sha256Hex(spec.account(config)).slice(0, 32)}`;
	const usable = (session: S | undefined): session is S => Boolean(session && session.expiresAt - spec.safetyMs > deps.now());

	async function read(storeKey: string): Promise<{ session?: S; failure?: { message: string; until: number } }> {
		const record = await deps.store.read(storeKey);
		return { session: record.session === undefined ? undefined : spec.parse(record.session), ...(record.failure ? { failure: record.failure } : {}) };
	}

	async function refresh(config: C, storeKey: string, expired: S | undefined): Promise<S> {
		const lockKey = `${spec.namespace}-login:${storeKey}`;
		const owner = `${spec.namespace}-session:${process.pid}:${randomUUID()}`;
		const waitDeadline = deps.now() + lockWaitMs;
		const waitSignal = AbortSignal.timeout(lockWaitMs);

		/** Fresh session or recent failure written by another process, if any. */
		const settled = async (): Promise<S | undefined> => {
			const record = await read(storeKey);
			if (usable(record.session) && record.session.id !== expired?.id) return record.session;
			if (record.failure && record.failure.until > deps.now()) throw new ProviderLoginUnavailableError(record.failure.message, record.failure.until - deps.now());
			return undefined;
		};

		for (;;) {
			const existing = await settled();
			if (existing) return existing;
			if (await deps.tryAcquireLock(lockKey, owner, lockLeaseMs)) break;
			if (deps.now() >= waitDeadline) throw new Error(`Timed out waiting for another ${spec.provider} login.`);
			await deps.sleep(LOCK_POLL_MS, waitSignal).catch((error) => {
				if (waitSignal.aborted) return;
				throw error;
			});
		}

		try {
			const existing = await settled();
			if (existing) return existing;
			await deps.store.clear(storeKey);
			try {
				const session = await spec.login(config, AbortSignal.timeout(spec.loginTimeoutMs));
				await deps.store.writeSession(storeKey, session, session.expiresAt);
				return session;
			} catch (error) {
				// The login signal only fires on its timeout, so a cancel here is a timeout failure.
				const message = error instanceof ProviderLoginError ? error.message
					: error instanceof OperationCanceledError ? new ProviderLoginError(spec.provider, `the login did not finish within ${spec.loginTimeoutMs / 1000} s`).message
						: `${spec.provider} login failed.`;
				const failure = { message, until: deps.now() + spec.failureTtlMs };
				await deps.store.writeFailure(storeKey, failure).catch(() => undefined);
				throw new ProviderLoginUnavailableError(failure.message, spec.failureTtlMs);
			}
		} finally {
			await deps.releaseLock(lockKey, owner).catch(() => undefined);
		}
	}

	return {
		key,
		async get(config, options = {}) {
			const storeKey = key(config);
			throwIfOperationCanceled(options.signal, canceled);
			const cached = await read(storeKey);
			if (usable(cached.session) && cached.session.id !== options.expiredSession?.id) return cached.session;
			// Callers share one flight but each keeps its own abort signal.
			const flightKey = `${storeKey}:${options.expiredSession?.id ?? ""}`;
			let flight = inflight.get(flightKey);
			if (!flight) {
				flight = refresh(config, storeKey, options.expiredSession).finally(() => inflight.delete(flightKey));
				inflight.set(flightKey, flight);
			}
			return raceAbort(flight, options.signal, undefined, canceled);
		},
	};
}

/** Resolve after `ms` even if `operation` never settles; bounds a login's browser cleanup. */
export async function boundedCleanup(operation: Promise<unknown>, ms = 10_000): Promise<void> {
	await raceTimeout(operation, ms, () => new Error("cleanup timed out")).catch(() => undefined);
}
