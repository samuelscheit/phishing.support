import { createHash } from "node:crypto";
import type { BrowserContext, Frame, Page } from "patchright";

import { acquireFabricPatchrightSession } from "../../../browser/fabric";
import { errorSummary } from "../../../error_text";
import { OperationCanceledError, raceAbort } from "../../worker/cancellation";
import { boundedCleanup, createLoginSessions, ProviderLoginError, type LoginSession, type LoginSessionDeps, type LoginSessions } from "../login_session/session";
import { mailedCodeReader, type MailedCodeReader } from "../mailed_code";
import { ALIBABA_CLOUD_PROVIDER } from "./definition";
import { asRecord } from "../../../values";

const PROVIDER = "Alibaba Cloud";
/** A login waits up to three minutes for its mailed code. */
export const ALIBABA_LOGIN_TIMEOUT_MS = 5 * 60_000;
export const ALIBABA_LOGIN_FAILURE_TTL_MS = 15 * 60_000;
/**
 * Alibaba issues the console login as browser-session cookies without an
 * expiry. The session is used until the console answers ConsoleNeedLogin,
 * which logs in again; this bound only stops a stale jar from lingering.
 */
export const ALIBABA_SESSION_TTL_MS = 24 * 60 * 60_000;

export type AlibabaCloudLoginConfig = { email: string; password: string };

export type AlibabaCookie = { name: string; value: string; domain: string };

/** A logged-in Reporting Center session: the account's cookie jar and the console's CSRF token. */
export type AlibabaCloudSession = LoginSession & { cookies: AlibabaCookie[]; secToken: string };

export function alibabaCloudLoginConfig(environment: Record<string, string | undefined> = process.env): AlibabaCloudLoginConfig {
	const email = environment.ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL?.trim() ?? "";
	const password = environment.ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD ?? "";
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL must be the Alibaba Cloud account's login email.");
	if (!password) throw new Error("ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD is required for Alibaba Cloud reporting.");
	return { email, password };
}

/** The console's CSRF token, which its own pages carry as `SEC_TOKEN: "…"`. */
export function consoleSecToken(html: string): string | undefined {
	return /\bSEC_TOKEN\s*:\s*["']([A-Za-z0-9_-]{8,128})["']/.exec(html)?.[1];
}

const LOGIN_COOKIE = "login_aliyunid_ticket";

/** Build a session from the console's cookies; only a jar with the login ticket is one. */
export function buildAlibabaCloudSession(cookies: readonly AlibabaCookie[], secToken: string, now: number): AlibabaCloudSession {
	const ticket = cookies.find((cookie) => cookie.name === LOGIN_COOKIE)?.value;
	if (!ticket) throw new Error("missing login ticket");
	return {
		id: createHash("sha256").update(ticket).digest("hex").slice(0, 32),
		cookies: cookies.map(({ name, value, domain }) => ({ name, value, domain })),
		secToken,
		expiresAt: now + ALIBABA_SESSION_TTL_MS,
	};
}

export function parseAlibabaCloudSession(value: unknown): AlibabaCloudSession | undefined {
	const record = asRecord(value);
	if (!record || typeof record.id !== "string" || typeof record.secToken !== "string" || typeof record.expiresAt !== "number" || !Array.isArray(record.cookies)) return undefined;
	const cookies = record.cookies.map(asRecord);
	if (!cookies.every((cookie) => cookie && typeof cookie.name === "string" && typeof cookie.value === "string" && typeof cookie.domain === "string")) return undefined;
	return { id: record.id, secToken: record.secToken, expiresAt: record.expiresAt, cookies: cookies.map((cookie) => ({ name: cookie!.name as string, value: cookie!.value as string, domain: cookie!.domain as string })) };
}

function frameOf(page: Page, path: string): Frame | undefined {
	return page.frames().find((frame) => frame.url().includes(path));
}

function onConsole(page: Page): boolean {
	return new URL(page.url()).origin === ALIBABA_CLOUD_PROVIDER.consoleOrigin;
}

export type AlibabaLoginDependencies = { readCode?: MailedCodeReader; clock?: () => number };

/**
 * Log in through Alibaba's login page: the password form in its
 * passport.alibabacloud.com frame, then, from a browser it does not know, the
 * identity check with a code mailed to the account address, which is the
 * service mailbox. Returns the console's cookies and CSRF token.
 */
export async function loginWithContext(
	context: BrowserContext,
	config: AlibabaCloudLoginConfig,
	signal: AbortSignal,
	dependencies: AlibabaLoginDependencies = {},
): Promise<AlibabaCloudSession> {
	const clock = dependencies.clock ?? Date.now;
	const step = <T>(operation: Promise<T>) => raceAbort(operation, signal, undefined, "Alibaba Cloud login was canceled.");
	const deadline = clock() + ALIBABA_LOGIN_TIMEOUT_MS;
	const remaining = () => Math.max(1, deadline - clock());
	const page = await step(context.newPage());
	let stage = "the login page did not load";
	try {
		await step(page.goto(ALIBABA_CLOUD_PROVIDER.loginUrl, { waitUntil: "domcontentloaded", timeout: remaining() }));
		stage = "the login form did not appear";
		let form: Frame | undefined;
		while (!(form = frameOf(page, "/mini_login.htm")) && clock() < deadline) await step(page.waitForTimeout(250));
		if (!form) throw new Error(stage);
		await step(form.fill("#fm-login-id", config.email, { timeout: remaining() }));
		await step(form.fill("#fm-login-password", config.password, { timeout: remaining() }));
		stage = "the login button could not be pressed";
		await step(form.click("#fm-login-submit", { timeout: remaining() }));

		stage = "the login page neither opened the console nor asked for the mailed code";
		let verify: Frame | undefined;
		while (!onConsole(page) && !(verify = frameOf(page, "/identity_verify.htm")) && clock() < deadline) {
			const refusal = await form.evaluate(() => {
				const message = document.querySelector(".login-error-msg, .fm-error, [class*='error'] .msg");
				const slider = document.querySelector("#nocaptcha, .nc-container, #baxia-dialog-content");
				return { message: (message as HTMLElement | null)?.innerText.trim() ?? "", slider: Boolean(slider && (slider as HTMLElement).offsetParent) };
			}).catch(() => ({ message: "", slider: false }));
			if (refusal.slider) throw new Error((stage = "Alibaba asked for a slider check"));
			if (refusal.message) throw new Error((stage = `Alibaba refused the sign-in ("${refusal.message.slice(0, 120)}")`));
			await step(page.waitForTimeout(500));
		}
		if (verify) {
			stage = "the mailed code could not be requested";
			const requestedAt = new Date(clock());
			await step(verify.click("#J_GetCode_Email", { timeout: remaining() }));
			stage = "the mailed code did not arrive";
			const code = await step((dependencies.readCode ?? mailedCodeReader(ALIBABA_CLOUD_PROVIDER.codeMail))(requestedAt, signal));
			stage = "the mailed code was not accepted";
			await step(verify.fill("#J_Checkcode", code, { timeout: remaining() }));
			await step(verify.click(".submit button", { timeout: remaining() }));
		}
		stage = "the console did not open after sign-in";
		await step(page.waitForURL((url) => url.origin === ALIBABA_CLOUD_PROVIDER.consoleOrigin, { timeout: remaining() }));
		await step(page.waitForLoadState("domcontentloaded", { timeout: remaining() }));
		stage = "the console page carried no CSRF token";
		const secToken = consoleSecToken(await step(page.content()));
		if (!secToken) throw new Error(stage);
		stage = "the console issued no login ticket";
		const cookies = await step(context.cookies(`${ALIBABA_CLOUD_PROVIDER.consoleOrigin}/`));
		return buildAlibabaCloudSession(cookies, secToken, clock());
	} catch (error) {
		const timedOut = signal.reason instanceof DOMException && signal.reason.name === "TimeoutError";
		if (error instanceof OperationCanceledError && !timedOut) throw error;
		// Browser errors can echo typed values; surface only the step.
		throw new ProviderLoginError(PROVIDER, `${stage}${timedOut ? ` within ${ALIBABA_LOGIN_TIMEOUT_MS / 1000} s` : ""}`);
	} finally {
		await boundedCleanup(page.close());
	}
}

async function loginWithFabric(config: AlibabaCloudLoginConfig, signal: AbortSignal): Promise<AlibabaCloudSession> {
	const launch = acquireFabricPatchrightSession({ operation: "alibaba-cloud-login" }, { egress: "reporting", leaseMode: "clone" });
	const fabric = await raceAbort(launch, signal, () => {
		void launch.then((late) => late.cancel().catch(() => undefined)).catch(() => undefined);
	}, "Alibaba Cloud login was canceled.").catch((error: unknown) => {
		if (error instanceof OperationCanceledError) throw error;
		throw new ProviderLoginError(PROVIDER, `no browser was available (${errorSummary(error)})`);
	});
	try {
		return await loginWithContext(fabric.context, config, signal);
	} finally {
		await boundedCleanup(fabric.release());
	}
}

export function createAlibabaCloudSessions(
	login: (config: AlibabaCloudLoginConfig, signal: AbortSignal) => Promise<AlibabaCloudSession> = loginWithFabric,
	overrides: Partial<LoginSessionDeps> = {},
): LoginSessions<AlibabaCloudLoginConfig, AlibabaCloudSession> {
	return createLoginSessions({
		provider: PROVIDER,
		namespace: "alibaba-cloud",
		account: (config) => config.email.toLowerCase(),
		login,
		parse: parseAlibabaCloudSession,
		loginTimeoutMs: ALIBABA_LOGIN_TIMEOUT_MS,
		failureTtlMs: ALIBABA_LOGIN_FAILURE_TTL_MS,
		safetyMs: 60_000,
	}, overrides);
}

export const alibabaCloudSessions = createAlibabaCloudSessions();
