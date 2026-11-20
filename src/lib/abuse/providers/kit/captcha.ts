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

/** Whether the captcha service can be paid at all. */
export const captchaCredentialsPresent = () => captchaCredentialsProblem() === undefined;

/** Solve one captcha through Death by Captcha; `parameters` are the page's site key and URL under the provider's own names. */
export function solveCaptchaToken(
	spec: { type: number; parametersField: string; parameters: Record<string, unknown> },
	signal?: AbortSignal,
): Promise<string> {
	return solveDeathByCaptchaToken({ ...spec, ...(signal ? { signal } : {}) });
}
