/**
 * Browser Fabric boundary for Phishing Support.
 *
 * This application owns report-domain logic only. Browser Fabric owns every
 * Chromium process, browser profile, egress policy, CDP capability, and lease
 * transition. Browser-session lifecycle calls and CDP libraries both go
 * through the private per-application relay; the Fabric credential stays in
 * that Browser Fabric-owned process.
 */
import type { Browser as PuppeteerBrowser } from "rebrowser-puppeteer-core";

import {
	FABRIC_BROWSER_SESSION_ID_PATTERN,
	fabricBrowserSessionIdFromProviderPayload,
	isFabricBrowserSessionId,
} from "../fabric/session";

type FabricScalar = string | number | boolean | null;
type FabricEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Which Fabric egress policy a browser session uses. `phishing` (default) opens
 * attacker-controlled pages through Tor; `reporting` talks to abuse portals and
 * provider dashboards from a direct, non-anonymised exit; `residential` leaves
 * through the operator's own connection (a Tailscale exit node) for phishing
 * pages that cloak Tor and datacenter visitors.
 */
export type FabricEgress = "phishing" | "reporting" | "residential";

export const DEFAULT_FABRIC_PHISHING_EGRESS_POLICY_REF = "egress_tor-egress@1";
export const DEFAULT_FABRIC_REPORTING_EGRESS_POLICY_REF = "egress_direct-egress@1";
export const DEFAULT_FABRIC_RESIDENTIAL_EGRESS_POLICY_REF = "egress_mac-exit@1";

/** Per-session selection shared by every Fabric acquire function. */
export interface FabricSessionOptions {
	leaseMode?: "writer" | "clone";
	egress?: FabricEgress;
	/** Explicitly opt into a recorder plus one automation client. */
	maxExternalConnections?: 1 | 2;
}
type FabricFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface FabricBrowserConfig {
	baseUrl: string;
	project: string;
	profileRef?: string;
	recipeRef: string;
	runtime: "rebrowser-puppeteer";
	egressPolicyRefs: Readonly<Record<FabricEgress, string>>;
	artifactPolicyRef: string;
	ttlSeconds: number;
	/** Test-only transport seam. Production uses the Basic-authenticated Fabric edge. */
	fetch?: FabricFetch;
}

export type FabricSessionStatus =
	| "queued"
	| "allocating"
	| "ready"
	| "active"
	| "releasing"
	| "released"
	| "cancelled"
	| "failed"
	| "timed_out";

type FabricSessionResponse = {
	id: string;
	status: FabricSessionStatus;
};

/** A Fabric-owned browser lease with no exposed CDP capability. */
export interface FabricBrowserSessionLease {
	id: string;
	heartbeat(): Promise<void>;
	release(): Promise<void>;
	cancel(): Promise<void>;
}

/** A Fabric browser presented to Skyvern through the fixed internal relay. */
export interface FabricSkyvernBrowserSession extends FabricBrowserSessionLease {
	/** Opaque relay route; it contains no Fabric capability query parameter. */
	browserAddress: string;
}

export interface FabricPatchrightSession {
	id: string;
	browser: any;
	context: any;
	release(): Promise<void>;
	cancel(): Promise<void>;
}

export type FabricSkyvernTaskBinding = {
	/** Opaque Fabric browser-session ID retained next to the local Skyvern run. */
	sessionId: string;
	/** Fixed-origin relay URL that hides Fabric's one-time CDP capability. */
	browserAddress: string;
	release(): Promise<void>;
	cancel(): Promise<void>;
};

const TERMINAL_SESSION_STATUSES = new Set<FabricSessionStatus>([
	"released",
	"cancelled",
	"failed",
	"timed_out",
]);
const SENSITIVE_METADATA_KEY = /(password|passphrase|secret|token|cookie|credential|authorization|proxy|otp|api[_-]?key)/i;

function requiredEnvironment(environment: FabricEnvironment, name: string): string {
	const value = environment[name]?.trim();
	if (!value) throw new Error(`${name} is required when FABRIC_API_URL is configured`);
	return value;
}

function requiredReference(environment: FabricEnvironment, name: string, prefix: string): string {
	const value = requiredEnvironment(environment, name);
	if (!new RegExp(`^${prefix}[A-Za-z0-9][A-Za-z0-9_.@-]{0,255}$`).test(value)) {
		throw new Error(`${name} must be a valid ${prefix} reference`);
	}
	return value;
}

function optionalReference(environment: FabricEnvironment, name: string, prefix: string): string | undefined {
	const value = environment[name]?.trim();
	if (!value) return undefined;
	if (!new RegExp(`^${prefix}[A-Za-z0-9][A-Za-z0-9_.@-]{0,255}$`).test(value)) {
		throw new Error(`${name} must be a valid ${prefix} reference`);
	}
	return value;
}

function referenceWithDefault(environment: FabricEnvironment, name: string, prefix: string, fallback: string): string {
	return optionalReference(environment, name, prefix) ?? fallback;
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

	const profileRef = optionalReference(environment, "FABRIC_PHISHING_PROFILE_REF", "profile_");
	if (!profileRef) throw new Error("FABRIC_PHISHING_PROFILE_REF is required for every Phishing Support Fabric browser operation");
	const ttlSeconds = Number(requiredEnvironment(environment, "FABRIC_PHISHING_TTL_SECONDS"));
	if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 14_400) {
		throw new Error("FABRIC_PHISHING_TTL_SECONDS must be an integer from 60 to 14400");
	}

	return {
		baseUrl: fabricApiBaseUrl(apiUrl),
		project: requiredReference(environment, "FABRIC_PROJECT", "project_"),
		profileRef,
		recipeRef: requiredReference(environment, "FABRIC_PHISHING_RECIPE_REF", "recipe_"),
		runtime: "rebrowser-puppeteer",
		egressPolicyRefs: {
			phishing: referenceWithDefault(environment, "FABRIC_PHISHING_EGRESS_POLICY_REF", "egress_", DEFAULT_FABRIC_PHISHING_EGRESS_POLICY_REF),
			reporting: referenceWithDefault(environment, "FABRIC_REPORTING_EGRESS_POLICY_REF", "egress_", DEFAULT_FABRIC_REPORTING_EGRESS_POLICY_REF),
			residential: referenceWithDefault(environment, "FABRIC_RESIDENTIAL_EGRESS_POLICY_REF", "egress_", DEFAULT_FABRIC_RESIDENTIAL_EGRESS_POLICY_REF),
		},
		artifactPolicyRef: requiredReference(environment, "FABRIC_PHISHING_ARTIFACT_POLICY_REF", "artifact-policy_"),
		ttlSeconds,
	};
}

export { fabricBrowserSessionIdFromProviderPayload, isFabricBrowserSessionId } from "../fabric/session";

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
		...(config.profileRef === undefined ? {} : { profileRef: config.profileRef }),
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

async function fabricRequest<T>(
	config: FabricBrowserConfig,
	path: string,
	init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
	let response: Response;
	try {
		response = await (config.fetch ?? globalThis.fetch)(resourceUrl(config, path), {
			method: init.method ?? "GET",
			headers: {
				accept: "application/json",
				...(init.body === undefined ? {} : { "content-type": "application/json" }),
				...(init.idempotencyKey === undefined ? {} : { "idempotency-key": init.idempotencyKey }),
			},
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
		});
	} catch {
		throw new Error("Browser Fabric transport request failed");
	}

	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		const problem = body as { detail?: unknown };
		throw new Error(typeof problem.detail === "string" ? problem.detail : `Browser Fabric request failed (${response.status})`);
	}
	return body as T;
}

async function sessionAction(config: FabricBrowserConfig, sessionId: string, action: "heartbeat" | "release" | "cancel"): Promise<void> {
	await fabricRequest(config, `/browser-sessions/${encodeURIComponent(assertFabricBrowserSessionId(sessionId))}/${action}`, { method: "POST" });
}

async function acquireFabricSession(
	config: FabricBrowserConfig,
	metadata: Record<string, FabricScalar>,
	{ leaseMode = "writer", egress = "phishing", maxExternalConnections = 1 }: FabricSessionOptions,
): Promise<string> {
	const idempotencyKey = `phishing-${crypto.randomUUID()}`;
	const created = await fabricRequest<FabricSessionResponse>(config, "/browser-sessions", {
		method: "POST",
		idempotencyKey,
		body: buildFabricBrowserSessionCreatePayload(config, metadata, leaseMode, idempotencyKey, egress, maxExternalConnections),
	});
	const sessionId = assertFabricBrowserSessionId(created.id);
	if (TERMINAL_SESSION_STATUSES.has(created.status)) {
		throw new Error(`Browser Fabric session ended in ${created.status}`);
	}
	// Do not poll the session resource here. A ready response carries an
	// ephemeral CDP capability intended solely for the mTLS relay sidecar. The
	// caller opens the fixed relay route immediately; the relay waits for
	// readiness internally and keeps that capability in its own memory.
	return sessionId;
}

const SESSION_HEARTBEAT_MS = 10_000;
/** How long a client waits for a free relay connection before giving up on its session. */
const RELAY_CAPACITY_WAIT_MS = 5 * 60_000;
const RELAY_CAPACITY_RETRY_MS = 2_000;

/**
 * The relay refuses a WebSocket upgrade with HTTP 503 while all of its
 * connections are taken; CDP clients report that as a failed handshake.
 */
export function isRelayCapacityError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /Expected 101 status code|Unexpected server response: 503/i.test(message);
}

/**
 * Open a CDP client through the relay, waiting while the relay is at capacity
 * (long-running Skyvern probes can hold several connections). The allocated
 * session is kept alive meanwhile, so a busy relay delays work instead of
 * failing it.
 */
export async function connectThroughRelay<T>(
	connect: () => Promise<T>,
	heartbeat: () => Promise<void>,
	options: { waitMs?: number; retryMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
	const waitMs = options.waitMs ?? RELAY_CAPACITY_WAIT_MS;
	const retryMs = options.retryMs ?? RELAY_CAPACITY_RETRY_MS;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const deadline = Date.now() + waitMs;
	let lastHeartbeat = Date.now();
	for (;;) {
		try {
			return await connect();
		} catch (error) {
			if (!isRelayCapacityError(error) || Date.now() >= deadline) throw error;
		}
		await sleep(retryMs);
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

async function allowInsecureCertificates(browser: any): Promise<void> {
	if (typeof browser?.newBrowserCDPSession !== "function") return;
	const cdp = await browser.newBrowserCDPSession();
	try {
		await cdp.send("Security.setIgnoreCertificateErrors", { ignore: true });
	} finally {
		try {
			await cdp.detach?.();
		} catch {
			// Detaching the short-lived setup session is best-effort.
		}
	}
}

/** Acquire a Fabric browser lease without exposing Fabric's CDP capability. */
export async function acquireFabricBrowserSession(
	metadata: Record<string, FabricScalar> = {},
	options: FabricSessionOptions = {},
): Promise<FabricBrowserSessionLease> {
	const config = fabricBrowserConfigFromEnvironment();
	if (!config) throw new Error("FABRIC_API_URL is required; Phishing Support never launches a local browser");
	const sessionId = await acquireFabricSession(config, metadata, options);
	let finished = false;
	const finish = async (action: "release" | "cancel") => {
		if (finished) return;
		finished = true;
		await sessionAction(config, sessionId, action).catch(() => undefined);
	};
	return {
		id: sessionId,
		heartbeat: async () => {
			if (!finished) await sessionAction(config, sessionId, "heartbeat");
		},
		release: () => finish("release"),
		cancel: () => finish("cancel"),
	};
}

/** Allocate a disposable Fabric browser for one dynamic Skyvern task. */
export async function acquireFabricSkyvernBrowserSession(
	metadata: Record<string, FabricScalar> = {},
	options: Pick<FabricSessionOptions, "egress" | "maxExternalConnections"> = {},
): Promise<FabricSkyvernBrowserSession> {
	const lease = await acquireFabricBrowserSession(metadata, { ...options, leaseMode: "clone" });
	try {
		return { ...lease, browserAddress: fabricRelayEndpoint(lease.id) };
	} catch (error) {
		await lease.cancel().catch(() => undefined);
		throw error;
	}
}

/** Bind a dynamic Skyvern task to a Fabric-owned browser without leaking a capability. */
export async function acquireFabricSkyvernTaskBinding(
	metadata: Record<string, FabricScalar> = {},
	options: Pick<FabricSessionOptions, "egress" | "maxExternalConnections"> = {},
): Promise<FabricSkyvernTaskBinding> {
	const session = await acquireFabricSkyvernBrowserSession(metadata, options);
	return {
		sessionId: session.id,
		browserAddress: session.browserAddress,
		release: session.release,
		cancel: session.cancel,
	};
}

function lifecycleConfig(): FabricBrowserConfig {
	const config = fabricBrowserConfigFromEnvironment();
	if (!config) throw new Error("FABRIC_API_URL is required; Phishing Support never launches a local browser");
	return config;
}

/** Renew a Fabric browser session while its dynamic Skyvern task remains active. */
export async function heartbeatFabricBrowserSession(sessionId: string): Promise<void> {
	await sessionAction(lifecycleConfig(), sessionId, "heartbeat");
}

/** Release a Fabric browser only after its attached Skyvern task is terminal. */
export async function releaseFabricBrowserSession(sessionId: string): Promise<void> {
	await sessionAction(lifecycleConfig(), sessionId, "release");
}

/** Stop an ambiguous or interrupted companion before it can continue using a browser. */
export async function cancelFabricBrowserSession(sessionId: string): Promise<void> {
	await sessionAction(lifecycleConfig(), sessionId, "cancel");
}

/** Disconnect only this Patchright CDP client; never send Browser.close to Fabric Chromium. */
export async function disconnectFabricPatchrightClient(browser: any): Promise<void> {
	// Patchright exposes no public disconnect. Its private connection owns this
	// client transport; calling Browser.close would instead terminate the
	// Fabric-owned remote Chromium process before its durable lease transition.
	const connection = browser?._connection;
	if (!connection || typeof connection.close !== "function") {
		throw new Error("Patchright did not expose a disconnectable CDP client transport");
	}
	connection.close();
}

/** Connect Rebrowser to a Fabric relay and map close/disconnect to lease release. */
export async function acquireFabricPuppeteerBrowser(
	metadata: Record<string, FabricScalar> = {},
	options: FabricSessionOptions = {},
): Promise<{ browser: PuppeteerBrowser; sessionId: string; release(): Promise<void> }> {
	const config = fabricBrowserConfigFromEnvironment();
	if (!config) throw new Error("FABRIC_API_URL is required; Phishing Support never launches a local browser");
	const sessionId = await acquireFabricSession(config, metadata, options);
	let browser: PuppeteerBrowser;
	try {
		const module = await import("rebrowser-puppeteer-core");
		browser = await connectThroughRelay(
			() => module.connect({ browserWSEndpoint: fabricRelayEndpoint(sessionId), acceptInsecureCerts: true }),
			() => sessionAction(config, sessionId, "heartbeat"),
		);
	} catch (error) {
		await sessionAction(config, sessionId, "cancel").catch(() => undefined);
		throw error;
	}

	const disconnect = browser.disconnect.bind(browser);
	const stopHeartbeat = startSessionHeartbeat(config, sessionId);
	let finished = false;
	const release = async () => {
		if (finished) return;
		finished = true;
		stopHeartbeat();
		try {
			await disconnect();
		} catch {
			// A lost client transport still requires Fabric's lease transition.
		}
		await sessionAction(config, sessionId, "release").catch(() => undefined);
	};
	(browser as unknown as { close: () => Promise<void> }).close = release;
	(browser as unknown as { disconnect: () => Promise<void> }).disconnect = release;
	browser.once?.("disconnected", () => { void release(); });
	return { browser, sessionId, release };
}

/** Attach one additional client to an existing Fabric session without owning its lease. */
export async function connectFabricPuppeteerClient(browserAddress: string): Promise<PuppeteerBrowser> {
	const module = await import("rebrowser-puppeteer-core");
	return module.connect({ browserWSEndpoint: browserAddress, acceptInsecureCerts: true });
}

/** Connect Patchright to Fabric's relay; Patchright close is disconnect + Fabric release. */
export async function acquireFabricPatchrightSession(
	metadata: Record<string, FabricScalar> = {},
	options: FabricSessionOptions = {},
): Promise<FabricPatchrightSession> {
	const config = fabricBrowserConfigFromEnvironment();
	if (!config) throw new Error("FABRIC_API_URL is required; Phishing Support never launches a local browser");
	const sessionId = await acquireFabricSession(config, metadata, options);
	let browser: any;
	try {
		const { chromium } = await import("patchright");
		browser = await connectThroughRelay(
			() => chromium.connectOverCDP(fabricRelayEndpoint(sessionId)),
			() => sessionAction(config, sessionId, "heartbeat"),
		);
		await allowInsecureCertificates(browser);
		const context = browser.contexts()[0];
		if (!context) throw new Error("Fabric browser did not expose its leased profile context");

		const stopHeartbeat = startSessionHeartbeat(config, sessionId);
		let finished = false;
		const finish = async (action: "release" | "cancel") => {
			if (finished) return;
			finished = true;
			stopHeartbeat();
			await disconnectFabricPatchrightClient(browser).catch(() => undefined);
			await sessionAction(config, sessionId, action).catch(() => undefined);
		};
		(browser as { close: () => Promise<void> }).close = () => finish("release");
		return {
			id: sessionId,
			browser,
			context,
			release: () => finish("release"),
			cancel: () => finish("cancel"),
		};
	} catch (error) {
		if (browser) await disconnectFabricPatchrightClient(browser).catch(() => undefined);
		await sessionAction(config, sessionId, "cancel").catch(() => undefined);
		if (error instanceof Error && error.message === "Fabric browser did not expose its leased profile context") throw error;
		throw error;
	}
}
