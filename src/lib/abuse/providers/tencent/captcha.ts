import { sleep } from "../../../utils";
import type { ProviderProxy } from "../proxy";
import { TENCENT_PROVIDER } from "./definition";

const deathByCaptchaEndpoint = "http://api.dbcapi.me/api";
const pollIntervalsMs = [1_000, 1_000, 2_000, 3_000, 2_000, 2_000, 3_000, 2_000, 2_000] as const;
const defaultPollIntervalMs = 3_000;
const captchaTimeoutMs = 120_000;

type DeathByCaptchaResponse = {
	captcha?: number | string;
	text?: string;
	is_correct?: boolean;
	[key: string]: unknown;
};

/** Tencent's token CAPTCHA reply requires both ticket and randstr. */
export type TencentCaptcha = {
	ret: 0;
	ticket: string;
	randstr: string;
	[key: string]: unknown;
};

/** Narrow enough for Bun test doubles without requiring browser-specific fetch members. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type TencentCaptchaCredentials = {
	username: string;
	password: string;
};

export type TencentCaptchaSolverDependencies = {
	fetch?: FetchLike;
	sleep?: (milliseconds: number) => Promise<void>;
	now?: () => number;
	credentials?: Partial<TencentCaptchaCredentials>;
};

/** Validate the only two solver credentials before writing the submission marker. */
export function getTencentCaptchaCredentials(overrides?: Partial<TencentCaptchaCredentials>): TencentCaptchaCredentials {
	const username = overrides?.username ?? process.env.DEATHBYCAPTCHA_USERNAME;
	const password = overrides?.password ?? process.env.DEATHBYCAPTCHA_PASSWORD;
	if (!username?.trim() || !password?.trim()) {
		throw new Error("Tencent Cloud abuse reporting requires DEATHBYCAPTCHA_USERNAME and DEATHBYCAPTCHA_PASSWORD.");
	}
	return { username: username.trim(), password: password.trim() };
}

function toDeathByCaptchaResponse(value: unknown): DeathByCaptchaResponse {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Death by Captcha returned an invalid response.");
	return value as DeathByCaptchaResponse;
}

async function deathByCaptchaRequest(params: {
	fetch: FetchLike;
	path: string;
	init?: RequestInit;
}): Promise<DeathByCaptchaResponse> {
	const response = await params.fetch(`${deathByCaptchaEndpoint}${params.path}`, {
		headers: { Accept: "application/json" },
		...params.init,
	});
	const body = await response.text();
	if (!response.ok) {
		throw new Error(`Death by Captcha request failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
	}

	try {
		return toDeathByCaptchaResponse(JSON.parse(body));
	} catch {
		throw new Error("Death by Captcha returned malformed JSON.");
	}
}

/** Validate the exact token shape Tencent's form expects from the solver. */
export function parseTencentCaptchaSolution(value: string): TencentCaptcha {
	let result: unknown;
	try {
		result = JSON.parse(value);
	} catch {
		throw new Error("Tencent CAPTCHA solver returned malformed JSON.");
	}
	if (!result || typeof result !== "object" || Array.isArray(result)) {
		throw new Error("Tencent CAPTCHA solver returned an invalid result.");
	}

	const captcha = result as Record<string, unknown>;
	if (captcha.ret !== 0 || typeof captcha.ticket !== "string" || !captcha.ticket.trim() || typeof captcha.randstr !== "string" || !captcha.randstr.trim()) {
		throw new Error("Tencent CAPTCHA solving failed.");
	}
	return captcha as TencentCaptcha;
}

/**
 * Use only the provider's documented type-23 Tencent token flow. The old
 * vendored DBC client carried unrelated image, socket, account, and report
 * APIs, none of which belong in this provider.
 */
export async function solveTencentCaptcha(
	proxy: ProviderProxy,
	dependencies: TencentCaptchaSolverDependencies = {},
): Promise<TencentCaptcha> {
	const request = dependencies.fetch ?? fetch;
	const pause = dependencies.sleep ?? sleep;
	const now = dependencies.now ?? Date.now;
	const credentials = getTencentCaptchaCredentials(dependencies.credentials);
	const form = new FormData();
	form.set("username", credentials.username);
	form.set("password", credentials.password);
	form.set("type", String(TENCENT_PROVIDER.captcha.type));
	form.set(
		"tencent_params",
		JSON.stringify({
			proxy: proxy.url,
			proxytype: proxy.captchaType,
			appid: TENCENT_PROVIDER.captcha.appId,
			pageurl: TENCENT_PROVIDER.reportPageUrl,
		}),
	);

	let captcha = await deathByCaptchaRequest({
		fetch: request,
		path: "/captcha",
		init: { method: "POST", body: form },
	});
	if (!captcha.captcha) throw new Error("Death by Captcha did not accept the Tencent CAPTCHA request.");

	const deadline = now() + captchaTimeoutMs;
	for (let attempt = 0; now() < deadline; attempt += 1) {
		if (typeof captcha.text === "string" && captcha.text.trim()) {
			if (captcha.is_correct !== true) throw new Error("Tencent CAPTCHA solver rejected the result.");
			return parseTencentCaptchaSolution(captcha.text);
		}

		await pause(pollIntervalsMs[attempt] ?? defaultPollIntervalMs);
		captcha = await deathByCaptchaRequest({
			fetch: request,
			path: `/captcha/${encodeURIComponent(String(captcha.captcha))}`,
		});
	}

	throw new Error("Tencent CAPTCHA solver timed out.");
}
