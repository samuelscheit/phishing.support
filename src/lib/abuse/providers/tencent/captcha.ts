import {
	getDeathByCaptchaCredentials,
	solveDeathByCaptchaToken,
	type DeathByCaptchaFetch,
} from "../../captcha/death_by_captcha";
import type { ProviderProxy } from "../proxy";
import { TENCENT_PROVIDER } from "./definition";

/** Tencent's token CAPTCHA reply requires both ticket and randstr. */
export type TencentCaptcha = {
	ret: 0;
	ticket: string;
	randstr: string;
	[key: string]: unknown;
};

/** Narrow enough for Bun test doubles without requiring browser-specific fetch members. */
export type FetchLike = DeathByCaptchaFetch;

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
	try {
		return getDeathByCaptchaCredentials(overrides);
	} catch {
		throw new Error("Tencent Cloud abuse reporting requires DEATHBYCAPTCHA_USERNAME and DEATHBYCAPTCHA_PASSWORD.");
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
	const credentials = getTencentCaptchaCredentials(dependencies.credentials);
	const solution = await solveDeathByCaptchaToken({
		type: TENCENT_PROVIDER.captcha.type,
		parametersField: "tencent_params",
		parameters: {
			proxy: proxy.url,
			proxytype: proxy.captchaType,
			appid: TENCENT_PROVIDER.captcha.appId,
			pageurl: TENCENT_PROVIDER.reportPageUrl,
		},
		credentials,
		fetch: dependencies.fetch,
		sleep: dependencies.sleep,
		now: dependencies.now,
	});
	return parseTencentCaptchaSolution(solution);
}
