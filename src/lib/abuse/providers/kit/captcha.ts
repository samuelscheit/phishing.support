import { getDeathByCaptchaCredentials, solveDeathByCaptchaToken } from "../../captcha/death_by_captcha";

/** Why the captcha service cannot be paid (the DEATHBYCAPTCHA_* credentials are unusable), or undefined when it can. */
export function captchaCredentialsProblem(): string | undefined {
	try {
		getDeathByCaptchaCredentials();
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** Solve one captcha through Death by Captcha; `parameters` are the page's site key and URL under the provider's own names. */
export function solveCaptchaToken(
	spec: { type: number; parametersField: string; parameters: Record<string, unknown> },
	signal?: AbortSignal,
): Promise<string> {
	return solveDeathByCaptchaToken({ ...spec, ...(signal ? { signal } : {}) });
}

/** The reCAPTCHA v2 checkbox of `pageUrl`, whose pinned definition names its site key. */
export const solveRecaptchaV2 = (captcha: { type: number; siteKey: string }, pageUrl: string, signal?: AbortSignal) => solveCaptchaToken({
	type: captcha.type,
	parametersField: "token_params",
	parameters: { googlekey: captcha.siteKey, pageurl: pageUrl },
}, signal);
