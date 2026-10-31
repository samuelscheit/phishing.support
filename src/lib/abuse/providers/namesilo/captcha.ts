import {
	getDeathByCaptchaCredentials,
	solveDeathByCaptchaToken,
	type DeathByCaptchaCredentials,
	type DeathByCaptchaSolverDependencies,
} from "../../captcha/death_by_captcha";
import { NAMESILO_PROVIDER } from "./definition";

export type NameSiloCaptchaSolverDependencies = DeathByCaptchaSolverDependencies;

/** Validate NameSilo's solver credentials before a durable run is created. */
export function getNameSiloCaptchaCredentials(
	overrides?: Partial<DeathByCaptchaCredentials>,
): DeathByCaptchaCredentials {
	try {
		return getDeathByCaptchaCredentials(overrides);
	} catch {
		throw new Error("NameSilo phishing reporting requires DEATHBYCAPTCHA_USERNAME and DEATHBYCAPTCHA_PASSWORD.");
	}
}

/** Solve the exact reCAPTCHA v2 token requested by NameSilo's public form. */
export async function solveNameSiloCaptcha(
	dependencies: NameSiloCaptchaSolverDependencies = {},
): Promise<string> {
	const credentials = getNameSiloCaptchaCredentials(dependencies.credentials);
	return solveDeathByCaptchaToken({
		type: NAMESILO_PROVIDER.captcha.type,
		parametersField: "token_params",
		parameters: {
			googlekey: NAMESILO_PROVIDER.captcha.siteKey,
			pageurl: NAMESILO_PROVIDER.reportPageUrl,
		},
		credentials,
		fetch: dependencies.fetch,
		sleep: dependencies.sleep,
		now: dependencies.now,
		requestTimeoutMs: dependencies.requestTimeoutMs,
		signal: dependencies.signal,
	});
}
