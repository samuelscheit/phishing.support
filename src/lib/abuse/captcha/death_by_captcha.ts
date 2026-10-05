const DEATH_BY_CAPTCHA_ENDPOINT = "https://api.dbcapi.me/api";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVALS_MS = [1_000, 1_000, 2_000, 3_000, 2_000, 2_000, 3_000, 2_000, 2_000] as const;
const DEFAULT_POLL_INTERVAL_MS = 3_000;

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Narrow enough for provider tests without requiring a browser-specific fetch implementation. */
export type DeathByCaptchaFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type DeathByCaptchaCredentials = {
	username: string;
	password: string;
};

export type DeathByCaptchaSolverDependencies = {
	fetch?: DeathByCaptchaFetch;
	sleep?: (milliseconds: number) => Promise<void>;
	now?: () => number;
	credentials?: Partial<DeathByCaptchaCredentials>;
	/** Per-request network deadline; the overall solver timeout remains separate. */
	requestTimeoutMs?: number;
	/** Cancel an in-flight solve when its owning worker job expires. */
	signal?: AbortSignal;
};

type DeathByCaptchaResponse = {
	captcha?: number | string;
	text?: string | null;
	is_correct?: boolean;
	error?: string;
	status?: string;
	[key: string]: unknown;
};

/** Validate credentials without ever placing them in a durable provider payload. */
export function getDeathByCaptchaCredentials(
	overrides?: Partial<DeathByCaptchaCredentials>,
	): DeathByCaptchaCredentials {
	const username = overrides?.username ?? process.env.DEATHBYCAPTCHA_USERNAME;
	const password = overrides?.password ?? process.env.DEATHBYCAPTCHA_PASSWORD;
	if (!username?.trim() || !password?.trim()) {
		throw new Error("Death by Captcha requires DEATHBYCAPTCHA_USERNAME and DEATHBYCAPTCHA_PASSWORD.");
	}
	return { username: username.trim(), password: password.trim() };
}

function parseResponse(body: string): DeathByCaptchaResponse {
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		throw new Error("Death by Captcha returned malformed JSON.");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Death by Captcha returned an invalid response.");
	}
	return value as DeathByCaptchaResponse;
}

function responseError(response: DeathByCaptchaResponse): string | undefined {
	const error = typeof response.error === "string" ? response.error.trim() : "";
	return error || undefined;
}

async function request(
	params: {
		fetch: DeathByCaptchaFetch;
		path: string;
		init?: RequestInit;
		requestTimeoutMs: number;
		signal?: AbortSignal;
	},
): Promise<DeathByCaptchaResponse> {
	const controller = new AbortController();
	const abortParent = () => controller.abort();
	if (params.signal?.aborted) throw new Error("Death by Captcha solve was canceled.");
	params.signal?.addEventListener("abort", abortParent, { once: true });
	let timedOut = false;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let parentAbort: (() => void) | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
			reject(new Error(`Death by Captcha request timed out after ${params.requestTimeoutMs} ms.`));
		}, params.requestTimeoutMs);
	});
	const parentAbortPromise = params.signal
		? new Promise<never>((_, reject) => {
			parentAbort = () => reject(new Error("Death by Captcha solve was canceled."));
			params.signal!.addEventListener("abort", parentAbort, { once: true });
		})
		: undefined;
	try {
		const { response, body } = await Promise.race([
			params.fetch(`${DEATH_BY_CAPTCHA_ENDPOINT}${params.path}`, {
				headers: { Accept: "application/json" },
				...params.init,
				signal: controller.signal,
			}).then(async (response) => ({ response, body: await response.text() })),
			timeoutPromise,
			...(parentAbortPromise ? [parentAbortPromise] : []),
		]);
		if (!response.ok) {
			throw new Error(`Death by Captcha request failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
		}
		const parsed = parseResponse(body);
		const error = responseError(parsed);
		if (error) throw new Error(`Death by Captcha rejected the request: ${error.slice(0, 500)}`);
		return parsed;
	} catch (error) {
		if (params.signal?.aborted) throw new Error("Death by Captcha solve was canceled.");
		if (timedOut || controller.signal.aborted) throw new Error(`Death by Captcha request timed out after ${params.requestTimeoutMs} ms.`);
		throw error;
	} finally {
		if (timeout) clearTimeout(timeout);
		params.signal?.removeEventListener("abort", abortParent);
		if (parentAbort) params.signal?.removeEventListener("abort", parentAbort);
	}
}

function captchaId(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
	if (typeof value === "string" && /^\d+$/.test(value) && value !== "0") return value;
	return undefined;
}

/**
 * Solve one token CAPTCHA through Death by Captcha's documented API. The
 * caller supplies the provider-specific type and JSON parameter field; this
 * keeps the transport, polling, credential validation, and bounded timeout
 * behavior shared by Cloudflare Turnstile and Tencent's token challenge.
 */
export async function solveDeathByCaptchaToken(params: {
	type: number;
	parametersField: string;
	parameters: Record<string, unknown>;
	timeoutMs?: number;
} & DeathByCaptchaSolverDependencies): Promise<string> {
	if (params.signal?.aborted) throw new Error("Death by Captcha solve was canceled.");
	if (!Number.isSafeInteger(params.type) || params.type <= 0) throw new Error("Death by Captcha CAPTCHA type must be a positive integer.");
	if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(params.parametersField)) throw new Error("Death by Captcha parameter field is invalid.");

	const credentials = getDeathByCaptchaCredentials(params.credentials);
	const fetcher = params.fetch ?? fetch;
	const pause = params.sleep ?? defaultSleep;
	const now = params.now ?? Date.now;
	const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Death by Captcha timeout must be positive.");
	const requestTimeoutMs = Math.min(params.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, timeoutMs);
	if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
		throw new Error("Death by Captcha request timeout must be positive.");
	}

	const form = new FormData();
	form.set("username", credentials.username);
	form.set("password", credentials.password);
	form.set("type", String(params.type));
	form.set(params.parametersField, JSON.stringify(params.parameters));

	let captcha = await request({
		fetch: fetcher,
		path: "/captcha",
		requestTimeoutMs,
		init: { method: "POST", body: form },
		signal: params.signal,
	});
	if (params.signal?.aborted) throw new Error("Death by Captcha solve was canceled.");
	const id = captchaId(captcha.captcha);
	if (!id) throw new Error("Death by Captcha did not accept the CAPTCHA request.");

	const deadline = now() + timeoutMs;
	const maximumPolls = Math.max(1, Math.ceil(timeoutMs / Math.min(...POLL_INTERVALS_MS)) + 1);
	for (let attempt = 0; attempt < maximumPolls && now() < deadline; attempt += 1) {
		const text = typeof captcha.text === "string" ? captcha.text.trim() : "";
		if (text) {
			if (captcha.is_correct !== true) throw new Error("Death by Captcha rejected the solved token.");
			return text;
		}

		const remaining = Math.max(0, deadline - now());
		if (remaining === 0) break;
		await pause(Math.min(POLL_INTERVALS_MS[attempt] ?? DEFAULT_POLL_INTERVAL_MS, remaining));
		if (params.signal?.aborted) throw new Error("Death by Captcha solve was canceled.");
		captcha = await request({
			fetch: fetcher,
			path: `/captcha/${encodeURIComponent(id)}`,
			requestTimeoutMs,
			signal: params.signal,
		});
	}

	throw new Error("Death by Captcha token solving timed out.");
}
