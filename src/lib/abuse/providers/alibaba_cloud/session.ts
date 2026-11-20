import type { BrowserContext, Frame, Page } from "patchright";

import { waitForCaptchaOutcome } from "../../../browser/captcha_state";
import { acquireFabricPatchrightSession } from "../../../browser/fabric";
import { errorSummary } from "../../../util/error_text";
import { OperationCanceledError, raceAbort } from "../../worker/cancellation";
import { boundedCleanup, createLoginSessions, ProviderLoginError, type LoginSession, type LoginSessionDeps, type LoginSessions } from "../login_session/session";
import { mailedCodeReader, type MailedCodeReader } from "../kit/mailed_code";
import { ALIBABA_CLOUD_PROVIDER } from "./definition";
import { asRecord } from "../../../util/values";
import { squash } from "../../../util/text";
import { sha256Hex } from "../../../util/hash";

const PROVIDER = "Alibaba Cloud";
/** A login waits up to three minutes for its mailed code. */
const ALIBABA_LOGIN_TIMEOUT_MS = 5 * 60_000;
const ALIBABA_LOGIN_FAILURE_TTL_MS = 15 * 60_000;
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
		id: sha256Hex(ticket).slice(0, 32),
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

/** The first line of a browser error, without the login's typed values: enough to tell a timeout from a detached frame. */
export function browserReason(error: unknown, config: AlibabaCloudLoginConfig): string {
	let line = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 160);
	for (const secret of [config.password, config.email]) if (secret) line = line.split(secret).join("[redacted]");
	return squash(line) || "no reason given";
}

/**
 * Log in through Alibaba's login page: the password form in its
 * passport.alibabacloud.com frame, then, from a browser it does not know, the
 * identity check with a code mailed to the account address, which is the
 * service mailbox. Returns the console's cookies and CSRF token.
 *
 * Alibaba's risk control (baxia) may put its "nocaptcha" slider in the way of
 * any of these requests and, once it passes, replays the request itself. The
 * browser's own solver drags it; each wait here is for the step's outcome,
 * and a solver that gives up ends the login with its reason.
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
	/** Wait until `done()` holds, the slider's solver failing ending it early. */
	const until = (label: string, done: () => boolean | Promise<boolean>) => step(waitForCaptchaOutcome(page, done, {
		label,
		timeoutMs: remaining(),
		pollMs: 500,
		now: clock,
		sleep: (ms) => page.waitForTimeout(ms),
		signal,
	}));
	let stage = "the login page did not load";
	try {
		await step(page.goto(ALIBABA_CLOUD_PROVIDER.loginUrl, { waitUntil: "domcontentloaded", timeout: remaining() }));
		stage = "the login form did not appear";
		// The login page loads and reloads its form frame on its own, so each
		// action finds the frame again instead of holding one that may be gone.
		const form = page.frameLocator("iframe#alibaba-login-box");
		await step(form.locator("#fm-login-id").fill(config.email, { timeout: remaining() }));
		await step(form.locator("#fm-login-password").fill(config.password, { timeout: remaining() }));
		stage = "the login button could not be pressed";
		// Sign-in replaces the form frame at once (identity check or console):
		// waiting for the click's own navigation would fail on the detached frame.
		await step(form.locator("#fm-login-submit").click({ timeout: remaining(), noWaitAfter: true }));

		stage = "the login page neither opened the console nor asked for the mailed code";
		await until("Alibaba's sign-in", async () => {
			if (onConsole(page) || frameOf(page, "/identity_verify.htm")) return true;
			const refused = await (frameOf(page, "/mini_login.htm")?.evaluate(() => {
				// "Your account name or password is incorrect." The block is always there, empty until a refusal.
				return [...document.querySelectorAll(".form-error, .login-error-msg, .fm-error")].some((element) => (element as HTMLElement).innerText.trim().length > 0);
			}) ?? Promise.resolve(false)).catch(() => false);
			// The page's text can echo the typed login; name only that it refused.
			if (refused) throw new Error((stage = "Alibaba refused the sign-in"));
			return false;
		});
		const verify = onConsole(page) ? undefined : frameOf(page, "/identity_verify.htm");
		if (verify) {
			stage = "the mailed code could not be requested";
			const requestedAt = new Date(clock());
			await step(verify.click("#J_GetCode_Email", { timeout: remaining() }));
			stage = "the mailed code did not arrive";
			// The code request may meet the slider first: the code is read while its solver works, and its failure ends the wait.
			const read = { done: false, code: "", error: undefined as unknown };
			void (dependencies.readCode ?? mailedCodeReader(ALIBABA_CLOUD_PROVIDER.codeMail))(requestedAt, signal)
				.then((code) => { read.code = code; }, (error: unknown) => { read.error = error ?? new Error("no code"); })
				.finally(() => { read.done = true; });
			await until("Alibaba's code request", () => read.done);
			if (read.error) throw read.error;
			stage = "the mailed code was not accepted";
			await step(verify.fill("#J_Checkcode", read.code, { timeout: remaining() }));
			await step(verify.click(".submit button", { timeout: remaining() }));
		}
		stage = "the console did not open after sign-in";
		await until("Alibaba's console", () => onConsole(page));
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
		// Name the step and the browser's reason, with the typed values cut out.
		const own = error instanceof Error && error.message === stage;
		throw new ProviderLoginError(PROVIDER, `${stage}${timedOut ? ` within ${ALIBABA_LOGIN_TIMEOUT_MS / 1000} s` : own ? "" : ` (${browserReason(error, config)})`}`);
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

function createAlibabaCloudSessions(
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
