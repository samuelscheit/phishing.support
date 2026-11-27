/**
 * Browser Fabric boundary for Phishing Support.
 *
 * This application owns report-domain logic only. Browser Fabric owns every
 * Chromium process, browser profile, egress policy, CDP capability, and lease
 * transition. Browser-session lifecycle calls and CDP libraries both go
 * through the private per-application relay; the Fabric credential stays in
 * that Browser Fabric-owned process.
 */
import type { Browser as PatchrightBrowser, BrowserContext as PatchrightContext } from "patchright";
import type { Browser as PuppeteerBrowser } from "rebrowser-puppeteer-core";

import {
	FABRIC_BROWSER_SESSION_ID_PATTERN,
	fabricBrowserSessionIdFromProviderPayload,
	isFabricBrowserSessionId,
} from "./fabric_session";
import { asError, errorSummary, errorText } from "../util/error_text";
import { errorChain } from "../util/error_chain";
import { abortable } from "../util/abort";
import { deadline } from "../util/async";
import { Semaphore, type SemaphoreRelease } from "../util/semaphore";
import { sleep, type Sleep } from "../util/sleep";
import { asRecord } from "../util/values";
import { type FetchLike } from "../http/fetch";

export type FabricScalar = string | number | boolean | null;
type FabricEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Which Fabric egress policy a browser session uses. `phishing` (default) opens
 * attacker-controlled pages through Tor; `reporting` talks to abuse portals and
 * provider dashboards from a direct, non-anonymised exit; `residential` leaves
 * through the operator's own connection (a Tailscale exit node) for phishing
 * pages that cloak Tor and datacenter visitors.
 */
export type FabricEgress = "phishing" | "reporting" | "residential";

/** How each egress appears to a visited site, for logs and evidence. */
export const FABRIC_EGRESS_LABEL: Readonly<Record<FabricEgress, string>> = { phishing: "Tor exit", reporting: "server IP", residential: "residential exit" };

/**
 * Defaults are Browser Fabric's built-ins, except the residential exit: Fabric
 * has no such built-in, so the deployment catalog must declare it (README,
 * "Browser Fabric catalog").
 */
const FABRIC_DEFAULTS = {
	runtime: "chrome",
	profileRef: "profile_default",
	/** Headful Chrome on Xvfb: phishing kits and provider forms cloak headless browsers. */
	recipeRef: "recipe_chrome@1",
	artifactPolicyRef: "artifact-policy_standard-30-days@1",
	ttlSeconds: 900,
	egressPolicyRefs: {
		phishing: "egress_tor@1",
		reporting: "egress_direct@1",
		residential: "egress_residential@1",
	},
} as const satisfies Omit<FabricBrowserConfig, "baseUrl" | "project">;

/** Per-session selection shared by every Fabric acquire function. */
export interface FabricSessionOptions {
	leaseMode?: "writer" | "clone";
	egress?: FabricEgress;
	/** Explicitly opt into a recorder plus one automation client. */
	maxExternalConnections?: 1 | 2;
	/**
	 * Fabric's create key; a retried create with the same key gets the same
	 * session instead of a second one. Random per lease by default; a caller
	 * that retries a lease itself passes its own.
	 */
	idempotencyKey?: string;
	/**
	 * Bounds the whole lease. Aborting it while the lease waits for a slot, is
	 * created, or connects rejects with the signal's own reason (never a
	 * `BrowserUnavailableError`) and cancels any session already created;
	 * aborting it later cancels the held lease.
	 */
	signal?: AbortSignal;
}
export interface FabricBrowserConfig {
	baseUrl: string;
	project: string;
	profileRef: string;
	recipeRef: string;
	/** Fabric's browser runtime; the CDP client (Rebrowser, Patchright, the task agent) is this app's choice. */
	runtime: string;
	egressPolicyRefs: Readonly<Record<FabricEgress, string>>;
	artifactPolicyRef: string;
	ttlSeconds: number;
	/** Test-only transport seam. Production uses the Basic-authenticated Fabric edge. */
	fetch?: FetchLike;
}

type FabricSessionStatus =
	| "queued"
	| "allocating"
	| "ready"
	| "active"
	| "releasing"
	| "released"
	| "cancelled"
	| "failed"
	| "timed_out";

/**
 * A Fabric browser lease for a raw-CDP client (the browser task agent). The
 * lease heartbeats itself until it is released or cancelled.
 */
export interface FabricCdpSession {
	id: string;
	/** Opaque relay route; it carries no Fabric capability. */
	cdpEndpoint: string;
	release(): Promise<void>;
	cancel(): Promise<void>;
}

export interface FabricPatchrightSession {
	id: string;
	browser: PatchrightBrowser;
	context: PatchrightContext;
	release(): Promise<void>;
	cancel(): Promise<void>;
}

const TERMINAL_SESSION_STATUSES = new Set<FabricSessionStatus>([
	"released",
	"cancelled",
	"failed",
	"timed_out",
]);
const SENSITIVE_METADATA_KEY = /(password|passphrase|secret|token|cookie|credential|authorization|proxy|otp|api[_-]?key)/i;

/**
 * No Fabric browser could be leased or connected. Nothing ran in a browser
 * yet, so nothing reached any provider: the work is safe to run again once
 * Fabric has a browser. Callers that wrap it keep it as the `cause`, so the
 * worker recognizes it through any wrapper (`isBrowserUnavailable`).
 */
export class BrowserUnavailableError extends Error {
	constructor(cause: unknown) {
		super(`no browser was available (${errorSummary(cause)})`, { cause });
		this.name = "BrowserUnavailableError";
	}
}

/** Whether `error`, or any error in its `cause` chain, is a `BrowserUnavailableError`. */
export function isBrowserUnavailable(error: unknown): boolean {
	return errorChain(error).some((entry) => entry instanceof BrowserUnavailableError);
}

/**
 * How many Fabric browsers this process leases at once:
 * `FABRIC_MAX_LOCAL_LEASES`, else one fewer than Fabric's own limit
 * (`FABRIC_MAX_ACTIVE_BROWSER_LEASES`, 4 by default), so this process never
 * takes Fabric's last browser.
 */
export function fabricLeaseLimitFromEnvironment(environment: FabricEnvironment = process.env): number {
	const count = (name: string) => {
		const value = environment[name]?.trim();
		return value && /^[1-9][0-9]{0,5}$/.test(value) ? Number(value) : undefined;
	};
	return count("FABRIC_MAX_LOCAL_LEASES") ?? Math.max(1, (count("FABRIC_MAX_ACTIVE_BROWSER_LEASES") ?? 4) - 1);
}

/**
 * How long a lease waits for a free local slot before the work is told no
 * browser is available: a job then waits without spending its attempts
 * instead of holding its worker slot (see `RELAY_CAPACITY_WAIT_MS`).
 */
const LEASE_SLOT_WAIT_MS = 2 * 60_000;

type FabricLeaseSlots = { semaphore: Semaphore; waitMs: number };
let leaseSlots: FabricLeaseSlots | undefined;

function fabricLeaseSlots(): FabricLeaseSlots {
	return leaseSlots ??= { semaphore: new Semaphore(fabricLeaseLimitFromEnvironment()), waitMs: LEASE_SLOT_WAIT_MS };
}

/**
 * Replace this process's lease slots: `limit` leases at once (the
 * environment's by default), each waiting at most `waitMs` for a slot.
 * Without options the next lease reads the environment again. Leases held
 * meanwhile give their slot back to the slots they took it from.
 */
export function configureFabricLeases(options: { limit?: number; waitMs?: number } = {}): void {
	leaseSlots = options.limit === undefined && options.waitMs === undefined
		? undefined
		: { semaphore: new Semaphore(options.limit ?? fabricLeaseLimitFromEnvironment()), waitMs: options.waitMs ?? LEASE_SLOT_WAIT_MS };
}

/** This process's lease slots right now: the limit, how many are free, and how many leases wait for one. */
export function fabricLeaseUsage(): { limit: number; available: number; waiting: number } {
	const { semaphore } = fabricLeaseSlots();
	return { limit: semaphore.capacity, available: semaphore.available, waiting: semaphore.waiting };
}

/** One local lease slot, waiting at most the configured time; the caller's abort rejects with its own reason. */
async function acquireLeaseSlot(signal: AbortSignal | undefined): Promise<SemaphoreRelease> {
	const { semaphore, waitMs } = fabricLeaseSlots();
	try {
		return await semaphore.acquire(deadline(waitMs, signal));
	} catch (error) {
		if (signal?.aborted) throw signal.reason;
		throw new BrowserUnavailableError(new Error(`all ${semaphore.capacity} browser leases of this process stayed busy for ${Math.round(waitMs / 1_000)} s`, { cause: error }));
	}
}

function requiredEnvironment(environment: FabricEnvironment, name: string): string {
	const value = environment[name]?.trim();
	if (!value) throw new Error(`${name} is required when FABRIC_API_URL is configured`);
	return value;
}

/**
 * A Fabric reference from the environment, or its default. Versioned catalog
 * kinds (recipes, egress policies, artifact policies) must name their version
 * (`recipe_chrome@1`); a bare name would let Fabric pick whatever is current.
 */
function reference(environment: FabricEnvironment, name: string, prefix: string, fallback?: string, versioned = true): string {
	const value = environment[name]?.trim() || fallback;
	if (!value) throw new Error(`${name} is required when FABRIC_API_URL is configured`);
	const pattern = versioned
		? new RegExp(`^${prefix}[a-z0-9][a-z0-9-]{0,62}@[1-9][0-9]{0,8}$`)
		: new RegExp(`^${prefix}[A-Za-z0-9][A-Za-z0-9_.@-]{0,255}$`);
	if (!pattern.test(value)) throw new Error(`${name} must be a valid ${prefix} reference${versioned ? " with a version (name@1)" : ""}`);
	return value;
}

function fabricApiBaseUrl(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("FABRIC_API_URL must be a valid credential-free HTTP(S) /v1 URL");
	}
	if (
		!["http:", "https:"].includes(parsed.protocol)
		|| !parsed.hostname
		|| parsed.username
		|| parsed.password
		|| parsed.search
		|| parsed.hash
		|| !/^\/v1\/?$/.test(parsed.pathname)
	) {
		throw new Error("FABRIC_API_URL must be a valid credential-free HTTP(S) /v1 URL");
	}
	return parsed.toString().replace(/\/+$/, "");
}

/** Parse the explicit production Fabric configuration; this has no local fallback. */
export function fabricBrowserConfigFromEnvironment(options: { environment?: FabricEnvironment } = {}): FabricBrowserConfig | undefined {
	const environment = options.environment ?? process.env;
	const apiUrl = environment.FABRIC_API_URL?.trim();
	if (!apiUrl) return undefined;

	const runtime = environment.FABRIC_BROWSER_RUNTIME?.trim() || FABRIC_DEFAULTS.runtime;
	if (!/^[a-z][a-z0-9-]{0,62}$/.test(runtime)) throw new Error("FABRIC_BROWSER_RUNTIME must be a Fabric runtime name such as chrome");
	const ttlText = environment.FABRIC_TTL_SECONDS?.trim();
	const ttlSeconds = ttlText ? Number(ttlText) : FABRIC_DEFAULTS.ttlSeconds;
	if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 14_400) {
		throw new Error("FABRIC_TTL_SECONDS must be an integer from 60 to 14400");
	}
	const egress = FABRIC_DEFAULTS.egressPolicyRefs;

	return {
		baseUrl: fabricApiBaseUrl(apiUrl),
		project: reference(environment, "FABRIC_PROJECT", "project_", undefined, false),
		profileRef: reference(environment, "FABRIC_PROFILE_REF", "profile_", FABRIC_DEFAULTS.profileRef, false),
		recipeRef: reference(environment, "FABRIC_RECIPE_REF", "recipe_", FABRIC_DEFAULTS.recipeRef),
		runtime,
		egressPolicyRefs: {
			phishing: reference(environment, "FABRIC_PHISHING_EGRESS_POLICY_REF", "egress_", egress.phishing),
			reporting: reference(environment, "FABRIC_REPORTING_EGRESS_POLICY_REF", "egress_", egress.reporting),
			residential: reference(environment, "FABRIC_RESIDENTIAL_EGRESS_POLICY_REF", "egress_", egress.residential),
		},
		artifactPolicyRef: reference(environment, "FABRIC_ARTIFACT_POLICY_REF", "artifact-policy_", FABRIC_DEFAULTS.artifactPolicyRef),
		ttlSeconds,
	};
}


function assertFabricBrowserSessionId(value: string): string {
	if (!FABRIC_BROWSER_SESSION_ID_PATTERN.test(value)) throw new Error("Browser Fabric session ID is invalid");
	return value;
}

/**
 * Produce the only CDP URL an application client may receive. The local relay
 * resolves the ephemeral Fabric capability itself over mTLS; this route cannot
 * carry a capability, target host, credentials, query string, or fragment.
 */
export function fabricRelayEndpoint(sessionId: string, relayUrl = process.env.FABRIC_CDP_RELAY_URL): string {
	let relay: URL;
	try {
		relay = new URL(requiredEnvironment({ FABRIC_CDP_RELAY_URL: relayUrl }, "FABRIC_CDP_RELAY_URL"));
	} catch {
		throw new Error("FABRIC_CDP_RELAY_URL must be a valid credential-free HTTP(S) origin");
	}
	if (
		!["http:", "https:"].includes(relay.protocol)
		|| !relay.hostname
		|| relay.username
		|| relay.password
		|| relay.search
		|| relay.hash
		|| relay.pathname !== "/"
	) {
		throw new Error("FABRIC_CDP_RELAY_URL must be a valid credential-free HTTP(S) origin");
	}
	assertFabricBrowserSessionId(sessionId);
	relay.protocol = relay.protocol === "https:" ? "wss:" : "ws:";
	relay.pathname = `/v1/cdp/${encodeURIComponent(sessionId)}`;
	return relay.toString();
}

function assertFabricMetadata(metadata: Record<string, FabricScalar>): void {
	for (const [key, value] of Object.entries(metadata)) {
		if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) throw new Error(`Browser Fabric metadata key ${key} is invalid`);
		if (SENSITIVE_METADATA_KEY.test(key)) {
			throw new Error(`Browser Fabric metadata ${key} must be supplied through an ephemeral Fabric input request`);
		}
		if (typeof value === "string" && value.length > 512) throw new Error(`Browser Fabric metadata ${key} is too long`);
	}
}

/** Build the only durable browser-session payload Phishing Support can submit. */
export function buildFabricBrowserSessionCreatePayload(
	config: Pick<FabricBrowserConfig, "project" | "profileRef" | "recipeRef" | "runtime" | "egressPolicyRefs" | "artifactPolicyRef" | "ttlSeconds">,
	metadata: Record<string, FabricScalar>,
	leaseMode: "writer" | "clone",
	idempotencyKey: string,
	egress: FabricEgress = "phishing",
	maxExternalConnections: 1 | 2 = 1,
): Record<string, unknown> {
	if (!idempotencyKey || idempotencyKey.length > 255) throw new Error("Browser Fabric idempotency key is invalid");
	assertFabricMetadata(metadata);
	return {
		project: config.project,
		idempotencyKey,
		runtime: config.runtime,
		browserRecipeRef: config.recipeRef,
		profileRef: config.profileRef,
		leaseMode,
		egressPolicyRef: config.egressPolicyRefs[egress],
		artifactPolicyRef: config.artifactPolicyRef,
		maxExternalConnections,
		ttlSeconds: config.ttlSeconds,
		metadata: { ...metadata, workload: "phishing-support" },
	};
}

function resourceUrl(config: FabricBrowserConfig, path: string): string {
	return `${config.baseUrl}${path}`;
}

/** Every Fabric API call ends within this, response body included. */
const FABRIC_REQUEST_TIMEOUT_MS = 30_000;
/** A create that failed in transit or with a Fabric 5xx is sent once more, under the same idempotency key. */
const CREATE_ATTEMPTS = 2;
const CREATE_RETRY_MS = 500;

/** A failed Fabric API call: `status` is Fabric's HTTP answer, undefined when none arrived. */
export class FabricRequestError extends Error {
	constructor(message: string, readonly status?: number, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "FabricRequestError";
	}

	/** Whether sending the same request again may succeed: no answer, or Fabric's own trouble. */
	get transient(): boolean {
		return this.status === undefined || this.status === 408 || this.status === 429 || this.status >= 500;
	}
}

/**
 * One Fabric API call, bounded by `FABRIC_REQUEST_TIMEOUT_MS`. A failure is a
 * `FabricRequestError` that names Fabric's HTTP status, with its problem
 * `detail` when the body has one. Callers never abort a call mid-flight: a
 * create Fabric already acted on would leave its session unknown
 * (`leaseFabricSession` races the call instead and cancels what it returns).
 */
async function fabricRequest<T>(
	config: FabricBrowserConfig,
	path: string,
	init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
	let response: Response;
	let body: unknown;
	try {
		response = await (config.fetch ?? globalThis.fetch)(resourceUrl(config, path), {
			method: init.method ?? "GET",
			headers: {
				accept: "application/json",
				...(init.body === undefined ? {} : { "content-type": "application/json" }),
				...(init.idempotencyKey === undefined ? {} : { "idempotency-key": init.idempotencyKey }),
			},
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
			signal: AbortSignal.timeout(FABRIC_REQUEST_TIMEOUT_MS),
		});
		body = await response.json().catch(() => undefined);
	} catch (error) {
		throw new FabricRequestError(`Browser Fabric transport request failed (${errorSummary(error)})`, undefined, { cause: error });
	}
	if (!response.ok) {
		const detail = asRecord(body)?.detail;
		const explained = typeof detail === "string" && detail.trim() ? `: ${detail.trim()}` : "";
		throw new FabricRequestError(`Browser Fabric request failed (HTTP ${response.status})${explained}`, response.status);
	}
	return body as T;
}

async function sessionAction(config: FabricBrowserConfig, sessionId: string, action: "heartbeat" | "release" | "cancel"): Promise<void> {
	await fabricRequest(config, `/browser-sessions/${encodeURIComponent(assertFabricBrowserSessionId(sessionId))}/${action}`, { method: "POST" });
}

/**
 * Create a session. A create lost in transit or refused by Fabric's own
 * trouble is sent once more under the same idempotency key, so a dropped
 * response never leaves a second, orphaned session behind. The create itself
 * is never aborted mid-flight (Fabric may have made the session already);
 * `signal` only stops the retry.
 */
async function acquireFabricSession(
	config: FabricBrowserConfig,
	metadata: Record<string, FabricScalar>,
	{ leaseMode = "writer", egress = "phishing", maxExternalConnections = 1, idempotencyKey = `phishing-${crypto.randomUUID()}`, signal }: FabricSessionOptions,
): Promise<string> {
	const body = buildFabricBrowserSessionCreatePayload(config, metadata, leaseMode, idempotencyKey, egress, maxExternalConnections);
	let created: Record<string, unknown> | undefined;
	for (let attempt = 1; !created; attempt++) {
		try {
			created = asRecord(await fabricRequest<unknown>(config, "/browser-sessions", { method: "POST", idempotencyKey, body })) ?? {};
		} catch (error) {
			if (attempt >= CREATE_ATTEMPTS || !(error instanceof FabricRequestError && error.transient)) throw error;
			await sleep(CREATE_RETRY_MS, signal);
			signal?.throwIfAborted();
		}
	}
	const sessionId = assertFabricBrowserSessionId(typeof created.id === "string" ? created.id : "");
	const status = created.status as FabricSessionStatus | undefined;
	if (status && TERMINAL_SESSION_STATUSES.has(status)) throw new Error(`Browser Fabric session ended in ${status}`);
	// Do not poll the session resource here. A ready response carries an
	// ephemeral CDP capability intended solely for the mTLS relay sidecar. The
	// caller opens the fixed relay route immediately; the relay waits for
	// readiness internally and keeps that capability in its own memory.
	return sessionId;
}

const SESSION_HEARTBEAT_MS = 10_000;
/**
 * How long a client waits for a free relay connection before giving up on its
 * session. Short: the worker reschedules a job without a browser
 * (`BrowserUnavailableError`) without spending its attempts, and waiting here
 * holds a worker slot; the control lane's 5-minute deadline must also leave
 * room for the session, the handshake and the work itself.
 */
const RELAY_CAPACITY_WAIT_MS = 60_000;
const RELAY_CAPACITY_RETRY_MS = 2_000;
/**
 * How long Patchright's CDP handshake may take after the relay's WebSocket
 * opened: it attaches to every target of a browser that is still starting
 * (and now runs the captcha solver too). Patchright's own default, 30 s, was
 * measured too short on a loaded production host (2026-11-21: two of three
 * handshakes timed out at 30 s, one took 14.7 s); Puppeteer's connect has no
 * such bound.
 */
const PATCHRIGHT_CONNECT_TIMEOUT_MS = 120_000;

/**
 * The relay refuses a WebSocket upgrade with HTTP 503 while all of its
 * connections are taken; CDP clients report that as a failed handshake, each
 * in its own words: "Expected 101 status code" or "Unexpected server
 * response: 503" (Rebrowser), "503 Service Unavailable" (Patchright).
 */
function isRelayCapacityError(error: unknown): boolean {
	const message = errorText(error);
	return /Expected 101 status code|Unexpected server response: 503|\b503 Service Unavailable\b/i.test(message);
}

/**
 * Open a CDP client through the relay, waiting while the relay is at capacity
 * (long-running agent visits can hold several connections). The allocated
 * session is kept alive meanwhile, so a busy relay delays work instead of
 * failing it.
 */
export async function connectThroughRelay<T>(
	connect: () => Promise<T>,
	heartbeat: () => Promise<void>,
	options: { waitMs?: number; retryMs?: number; sleep?: Sleep; signal?: AbortSignal } = {},
): Promise<T> {
	const { signal } = options;
	const waitMs = options.waitMs ?? RELAY_CAPACITY_WAIT_MS;
	const retryMs = options.retryMs ?? RELAY_CAPACITY_RETRY_MS;
	const wait = options.sleep ?? ((ms: number) => sleep(ms, signal));
	const giveUpAt = Date.now() + waitMs;
	let lastHeartbeat = Date.now();
	for (;;) {
		signal?.throwIfAborted();
		try {
			return await connect();
		} catch (thrown) {
			signal?.throwIfAborted();
			// Under Bun the CDP WebSocket handshake rejects with an ErrorEvent, not an Error.
			const error = asError(thrown);
			if (!isRelayCapacityError(error) || Date.now() >= giveUpAt) throw error;
		}
		await wait(retryMs);
		signal?.throwIfAborted();
		if (Date.now() - lastHeartbeat >= SESSION_HEARTBEAT_MS) {
			lastHeartbeat = Date.now();
			await heartbeat().catch(() => undefined);
		}
	}
}

function startSessionHeartbeat(config: FabricBrowserConfig, sessionId: string): () => void {
	const timer = setInterval(() => {
		void sessionAction(config, sessionId, "heartbeat").catch(() => undefined);
	}, SESSION_HEARTBEAT_MS);
	timer.unref?.();
	return () => clearInterval(timer);
}

/** A connected CDP client plus how to drop its own transport when the lease ends. */
interface FabricClientConnection<T> {
	value: T;
	/** Best-effort: a lost client transport must not block Fabric's lease transition. */
	disconnect?: () => Promise<unknown>;
}

interface FabricLease<T> {
	id: string;
	value: T;
	release(): Promise<void>;
	cancel(): Promise<void>;
}

/**
 * The one lifecycle every Fabric client shares: take one of the process's
 * lease slots, acquire a session, connect a client to it (cancelling the
 * session if that fails), heartbeat the lease, and finish it exactly once
 * with `release` (work done) or `cancel` (outcome unknown). Finishing stops
 * the heartbeat, drops the client transport, tells Fabric, then frees the
 * slot. A session that cannot be leased, acquired or connected is a
 * `BrowserUnavailableError`; an abort of `options.signal` rejects with its
 * own reason, cancels whatever was created, and later cancels the lease.
 */
async function leaseFabricSession<T>(
	config: FabricBrowserConfig,
	metadata: Record<string, FabricScalar>,
	options: FabricSessionOptions,
	connect: (sessionId: string, signal?: AbortSignal) => Promise<FabricClientConnection<T>>,
): Promise<FabricLease<T>> {
	const { signal } = options;
	const releaseSlot = await acquireLeaseSlot(signal);
	const cancelSession = (sessionId: string) => sessionAction(config, sessionId, "cancel").catch(() => undefined);
	let sessionId: string | undefined;
	let client: FabricClientConnection<T> | undefined;
	let create: Promise<string> | undefined;
	try {
		// A create still in flight at the abort may yet make a session: keep the slot until it settles and is cancelled.
		create = acquireFabricSession(config, metadata, options);
		sessionId = await abortable(create, signal, async (lateId) => {
			await cancelSession(lateId);
			releaseSlot();
		});
		client = await abortable(connect(sessionId, signal), signal, (late) => late.disconnect?.());
		signal?.throwIfAborted();
	} catch (error) {
		await client?.disconnect?.().catch(() => undefined);
		if (sessionId) {
			await cancelSession(sessionId);
			releaseSlot();
		} else if (signal?.aborted && create) {
			// If `create` rejects late, release the slot then; if it resolves late, `abortable`'s discard cancels and releases.
			void create.catch(() => releaseSlot());
		} else {
			releaseSlot();
		}
		if (signal?.aborted) throw signal.reason;
		throw new BrowserUnavailableError(error);
	}
	const leasedId = sessionId;
	const stopHeartbeat = startSessionHeartbeat(config, leasedId);
	let finished = false;
	const finish = async (action: "release" | "cancel") => {
		if (finished) return;
		finished = true;
		signal?.removeEventListener("abort", onAbort);
		stopHeartbeat();
		await client.disconnect?.().catch(() => undefined);
		await sessionAction(config, leasedId, action).catch(() => undefined);
		releaseSlot();
	};
	const onAbort = () => { void finish("cancel"); };
	signal?.addEventListener("abort", onAbort, { once: true });
	return { id: leasedId, value: client.value, release: () => finish("release"), cancel: () => finish("cancel") };
}

async function allowInsecureCertificates(browser: PatchrightBrowser): Promise<void> {
	const cdp = await browser.newBrowserCDPSession();
	try {
		await cdp.send("Security.setIgnoreCertificateErrors", { ignore: true });
	} finally {
		try {
			await cdp.detach();
		} catch {
			// Detaching the short-lived setup session is best-effort.
		}
	}
}

function requiredConfig(config = fabricBrowserConfigFromEnvironment()): FabricBrowserConfig {
	if (!config) throw new Error("FABRIC_API_URL is required; Phishing Support never launches a local browser");
	return config;
}

/**
 * Lease a disposable (clone) Fabric browser for one raw-CDP client: the
 * browser task agent connects to `cdpEndpoint` itself. The lease heartbeats
 * until `release` (the work finished) or `cancel` (its outcome is unknown, so
 * the browser must stop at once).
 */
export async function acquireFabricCdpSession(
	metadata: Record<string, FabricScalar> = {},
	options: Pick<FabricSessionOptions, "egress" | "idempotencyKey" | "signal"> = {},
	config: FabricBrowserConfig = requiredConfig(),
): Promise<FabricCdpSession> {
	const lease = await leaseFabricSession(config, metadata, { ...options, leaseMode: "clone" }, async (sessionId) => ({
		value: fabricRelayEndpoint(sessionId),
	}));
	return { id: lease.id, cdpEndpoint: lease.value, release: lease.release, cancel: lease.cancel };
}

/**
 * Stop a browser whose lease this process no longer holds in memory: a task
 * run interrupted by a crash or a fenced job, found through its durable
 * session ID.
 */
export async function cancelFabricBrowserSession(sessionId: string): Promise<void> {
	await sessionAction(requiredConfig(), sessionId, "cancel");
}

/**
 * Connect Rebrowser to a Fabric relay and map close/disconnect to lease
 * release. A browser that drops on its own (Fabric ended it) cancels the
 * lease, which frees its slot.
 */
export async function acquireFabricPuppeteerBrowser(
	metadata: Record<string, FabricScalar> = {},
	options: FabricSessionOptions = {},
	config: FabricBrowserConfig = requiredConfig(),
): Promise<{ browser: PuppeteerBrowser; sessionId: string; release(): Promise<void> }> {
	const lease = await leaseFabricSession(config, metadata, options, async (sessionId, signal) => {
		const module = await import("rebrowser-puppeteer-core");
		const browser = await connectThroughRelay(
			() => module.connect({ browserWSEndpoint: fabricRelayEndpoint(sessionId), acceptInsecureCerts: true }),
			() => sessionAction(config, sessionId, "heartbeat"),
			{ signal },
		);
		return { value: browser, disconnect: browser.disconnect.bind(browser) };
	});
	const { value: browser, release } = lease;
	(browser as unknown as { close: () => Promise<void> }).close = release;
	(browser as unknown as { disconnect: () => Promise<void> }).disconnect = release;
	browser.once?.("disconnected", () => { void lease.cancel(); });
	if (browser.connected === false) void lease.cancel();
	return { browser, sessionId: lease.id, release };
}

/** Connect Patchright to Fabric's relay; Patchright close is disconnect + Fabric release. */
export async function acquireFabricPatchrightSession(
	metadata: Record<string, FabricScalar> = {},
	options: FabricSessionOptions = {},
	config: FabricBrowserConfig = requiredConfig(),
): Promise<FabricPatchrightSession> {
	const lease = await leaseFabricSession(config, metadata, options, async (sessionId, signal) => {
		const { chromium } = await import("patchright");
		const browser = await connectThroughRelay(
			() => chromium.connectOverCDP(fabricRelayEndpoint(sessionId), { timeout: PATCHRIGHT_CONNECT_TIMEOUT_MS }),
			() => sessionAction(config, sessionId, "heartbeat"),
			{ signal },
		);
		// For a browser connected over CDP, Patchright's own close only closes
		// this client's CDP WebSocket (its "browser process" is that transport);
		// it sends no Browser.close to Fabric's Chromium. Keep it before close
		// becomes the lease release below. Never close `browser._connection`:
		// that is the process-wide in-process Patchright connection, and every
		// later Patchright call would fail with its stored "Target page,
		// context or browser has been closed" (2026-11-20/21 in production).
		const disconnect = browser.close.bind(browser);
		try {
			await allowInsecureCertificates(browser);
			const context = browser.contexts()[0];
			if (!context) throw new Error("Fabric browser did not expose its leased profile context");
			return { value: { browser, context }, disconnect };
		} catch (error) {
			await disconnect().catch(() => undefined);
			throw error;
		}
	});
	lease.value.browser.close = lease.release;
	// A browser that drops on its own (Fabric ended it) cancels the lease, which frees its slot.
	lease.value.browser.once("disconnected", () => { void lease.cancel(); });
	if (!lease.value.browser.isConnected()) void lease.cancel();
	return { id: lease.id, ...lease.value, release: lease.release, cancel: lease.cancel };
}
