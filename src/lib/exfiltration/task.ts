import type { SkyvernTaskPayload } from "../abuse/skyvern";
import type { ExfiltrationCanaries } from "./types";

export function buildExfiltrationProbeTask(pageUrl: string, canaries: ExfiltrationCanaries): SkyvernTaskPayload {
	const url = new URL(pageUrl);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Exfiltration probe URL must be a credential-free HTTP URL.");
	const immutableValues = {
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
			"This is a controlled defensive probe of a page already confirmed as phishing or payment fraud.",
			`Use only these synthetic values: ${JSON.stringify(immutableValues)}. Never enter, request, or retrieve real personal data, credentials, messages, account content, or payment data.`,
			"Fill every visible phishing form with the semantically matching synthetic values and submit it. Continue through at most three form stages, including a repeated-password or one-time-code stage when shown.",
			"Do not solve CAPTCHAs, authenticate to a real service, approve a real login, download or execute files, change browser settings, follow unrelated links, or perform any action outside the form flow.",
			"Stop when the form finishes, blocks the synthetic data, requests a CAPTCHA/operator approval, leaves the submitted site's flow, or three submissions have occurred.",
			"Return only a short factual result; network evidence is recorded independently.",
		].join("\n"),
		max_steps: Number(process.env.EXFILTRATION_SKYVERN_MAX_STEPS ?? 80),
		data_extraction_schema: {
			type: "object",
			properties: {
				submissionsAttempted: { type: "integer", minimum: 0, maximum: 3 },
				stoppedReason: { type: "string" },
			},
			required: ["submissionsAttempted", "stoppedReason"],
			additionalProperties: false,
		},
		engine: "skyvern-2.0",
		include_action_history_in_verification: true,
	};
}
