import type { SkyvernTaskPayload } from "../abuse/skyvern";
import type { ExfiltrationCanaries } from "./types";

/** Wall-clock investigation budget across all egress routes, spent before the evidence is reported. */
export const INVESTIGATION_BUDGET_MS = 8 * 60_000;
/** Form submissions the probe may make across the whole investigation. */
export const MAX_FORM_SUBMISSIONS = 3;

const DEFAULT_MAX_STEPS = 80;
const MAX_STEPS_LIMIT = 200;

/** Parse the optional step limit; a malformed value is a configuration error, never `NaN` sent to Skyvern. */
export function probeMaxSteps(value: string | undefined): number {
	const trimmed = value?.trim();
	if (!trimmed) return DEFAULT_MAX_STEPS;
	if (!/^\d+$/.test(trimmed)) throw new Error("EXFILTRATION_SKYVERN_MAX_STEPS must be a whole number.");
	const steps = Number(trimmed);
	if (steps < 1 || steps > MAX_STEPS_LIMIT) throw new Error(`EXFILTRATION_SKYVERN_MAX_STEPS must be from 1 to ${MAX_STEPS_LIMIT}.`);
	return steps;
}

/**
 * The approved scope of the investigation. CAPTCHAs are out of scope on purpose:
 * the agent stops and reports rather than solving one.
 */
export function buildExfiltrationProbeTask(
	pageUrl: string,
	canaries: ExfiltrationCanaries,
	maxSteps: number = probeMaxSteps(process.env.EXFILTRATION_SKYVERN_MAX_STEPS),
): SkyvernTaskPayload {
	const url = new URL(pageUrl);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Exfiltration probe URL must be a credential-free HTTP URL.");
	const syntheticValues = {
		email: canaries.email,
		password: canaries.password,
		phone: canaries.phone,
		cardNumber: canaries.cardNumber,
		oneTimeCode: canaries.oneTimeCode,
		name: `Phishing Support ${canaries.marker}`,
		address: "123 Test Avenue",
		city: "Testville",
		postalCode: "10001",
	};
	return {
		url: url.toString(),
		prompt: [
			"This is a controlled defensive investigation of a page already confirmed as phishing or payment fraud.",
			`Use only these synthetic values: ${JSON.stringify(syntheticValues)}. Never enter, request, or retrieve real personal data, credentials, messages, account content, or payment data.`,
			`Fill every visible phishing form with the semantically matching synthetic values and submit it. Continue through the kit's own flow, including a repeated-password or one-time-code stage when shown. Make at most ${MAX_FORM_SUBMISSIONS} form submissions in total.`,
			"Follow the kit's flow onto another domain only when a form, redirect, frame, or the page's own button leads to the next stage of the same sign-in or payment flow. Do not follow advertisements, footer or social links, search results, or links to the impersonated brand's real website.",
			"When the page offers a download or install control, click it once so the file is saved. Never open, run, install, execute, extract, or interact with any downloaded file, and never enter data into one.",
			"Do not solve CAPTCHAs or bot challenges, authenticate to a real service, approve a real login or second factor, grant browser permissions, install extensions, change browser settings, or accept a dialog that installs software.",
			`Stop when the flow finishes, blocks the synthetic data, shows a CAPTCHA or asks for operator approval, leaves the kit's flow, or ${MAX_FORM_SUBMISSIONS} submissions have been made. The investigation has a time limit of about eight minutes.`,
			"Return only a short factual result; network and download evidence is recorded independently.",
		].join("\n"),
		max_steps: maxSteps,
		data_extraction_schema: {
			type: "object",
			properties: {
				submissionsAttempted: { type: "integer", minimum: 0, maximum: MAX_FORM_SUBMISSIONS },
				stoppedReason: { type: "string", maxLength: 300 },
			},
			required: ["submissionsAttempted", "stoppedReason"],
			additionalProperties: false,
		},
		engine: "skyvern-2.0",
		include_action_history_in_verification: true,
	};
}
