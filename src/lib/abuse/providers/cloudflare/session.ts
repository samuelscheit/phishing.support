import type { BrowserContext, Page } from "patchright";

import { OperationCanceledError, raceAbort } from "../../worker/cancellation";
import { boundedCleanup, createLoginSessions, ProviderLoginError, withLoginBrowser, type LoginSessionOptions } from "../login_session/session";

const PROVIDER = "Cloudflare dashboard";

/** `id` is the x-atok token: it tells a refused session from its replacement. */
export type CloudflareSession = { id: string; atok: string; vses2: string; expiresAt: number };

export type CloudflareLoginConfig = { accountId: string; email: string; password: string };

const CLOUDFLARE_DASHBOARD_URL = "https://dash.cloudflare.com";
export const CLOUDFLARE_LOGIN_TIMEOUT_MS = 120_000;
const CLOUDFLARE_LOGIN_FAILURE_TTL_MS = 10 * 60_000;
/** Conservative lifetime when x-atok carries no parseable timestamp prefix. */
export const CLOUDFLARE_DEFAULT_SESSION_TTL_MS = 5 * 60_000;
const DASHBOARD_HOST = "dash.cloudflare.com";
/** Treat a session as expired slightly early so a request never races expiry. */
export const CLOUDFLARE_SESSION_SAFETY_MS = 60_000;

export type CloudflareSessionOptions = LoginSessionOptions<CloudflareSession>;

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
	return { id: atok, atok, vses2, expiresAt: parsed ?? now + CLOUDFLARE_DEFAULT_SESSION_TTL_MS };
}

/** Remove the OneTrust dialog, which can sit above the login form and challenge frame. */
async function dismissConsentBanner(page: Page): Promise<void> {
	await page.evaluate(() => {
		document.querySelector("#onetrust-consent-sdk")?.remove();
	}).catch(() => undefined);
}

function isDashboardUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.hostname === DASHBOARD_HOST;
	} catch {
		return false;
	}
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
		throw new ProviderLoginError(PROVIDER, loginStatus !== undefined && loginStatus >= 400
			? `Cloudflare refused the sign-in (HTTP ${loginStatus})`
			: `${stage}${timedOut ? ` within ${CLOUDFLARE_LOGIN_TIMEOUT_MS / 1000} s` : ""}`);
	} finally {
		await boundedCleanup(page.close());
	}
}

function loginWithFabric(config: CloudflareLoginConfig, signal: AbortSignal): Promise<CloudflareSession> {
	return withLoginBrowser(PROVIDER, "cloudflare-dashboard-login", signal, (context) => loginWithContext(context, config, signal));
}

function parseCloudflareSession(value: unknown): CloudflareSession | undefined {
	const v = value as Partial<CloudflareSession> | null;
	return v && typeof v.id === "string" && typeof v.atok === "string" && v.atok && typeof v.vses2 === "string" && v.vses2 && typeof v.expiresAt === "number"
		? { id: v.id, atok: v.atok, vses2: v.vses2, expiresAt: v.expiresAt } : undefined;
}

export const cloudflareLoginSessions = createLoginSessions<CloudflareLoginConfig, CloudflareSession>({
	provider: PROVIDER,
	namespace: "cloudflare-dashboard",
	account: (config) => `${config.accountId}\0${config.email.toLowerCase()}`,
	login: loginWithFabric,
	parse: parseCloudflareSession,
	loginTimeoutMs: CLOUDFLARE_LOGIN_TIMEOUT_MS,
	failureTtlMs: CLOUDFLARE_LOGIN_FAILURE_TTL_MS,
	safetyMs: CLOUDFLARE_SESSION_SAFETY_MS,
});

/** A valid dashboard session; see `LoginSessions.get`. */
export function getCloudflareSession(config: CloudflareLoginConfig, options: CloudflareSessionOptions = {}): Promise<CloudflareSession> {
	return cloudflareLoginSessions.get(config, options);
}
