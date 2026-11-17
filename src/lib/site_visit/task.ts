import { taskStepLimit, type BrowserTask } from "../browser_task/agent";
import type { ExfiltrationCanaries } from "../exfiltration/types";

/** Wall-clock budget of one site visit: the agent's walk through the site, from its first page to where the flow ends. */
export const VISIT_BUDGET_MS = 20 * 60_000;
/** Form submissions the agent may make in one visit. */
export const MAX_FORM_SUBMISSIONS = 10;

/** Parse the optional limit of the agent's model turns; each turn may batch several actions. */
export function visitMaxSteps(value: string | undefined): number {
	return taskStepLimit("SITE_VISIT_TASK_MAX_STEPS", value, 60, 150);
}

/**
 * The visit's task. The credential-shaped synthetic values (password, card
 * number, one-time code) are secrets: the agent types them as
 * `{{secret:NAME}}` placeholders, so they reach the page (and the network
 * recording) but never the model's prompt, its step log or the stored record.
 */
export type SiteVisitTask = Omit<BrowserTask, "startUrl"> & { secrets: Record<string, string> };
/** What the agent reports when it stops; the recording, not this, is the evidence. */
export type VisitAgentReport = {
	submissionsAttempted: number;
	downloadsStarted: number;
	/** The site turned the desktop away and asked to be opened on a phone. */
	asksForPhone: boolean;
	stoppedReason: string;
};

/**
 * The visit: go through a reported site the way its victim would, entering
 * only synthetic values, so the recording shows every page it asks for data
 * on, where that data goes, and what it makes the visitor download.
 * Token and checkbox CAPTCHAs (reCAPTCHA v2, Cloudflare Turnstile) are
 * cleared by the Fabric browser guardian; the agent waits for it and never
 * solves a challenge itself.
 */
export function buildSiteVisitTask(
	pageUrl: string,
	canaries: ExfiltrationCanaries,
	maxSteps: number = visitMaxSteps(process.env.SITE_VISIT_TASK_MAX_STEPS),
	/** What whoever asked for this visit wants done or looked at, on top of the walk itself. */
	instructions?: string,
): SiteVisitTask {
	const url = new URL(pageUrl);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("A site visit needs a credential-free HTTP URL.");
	const secrets = { password: canaries.password, cardNumber: canaries.cardNumber, oneTimeCode: canaries.oneTimeCode };
	const syntheticValues = {
		email: canaries.email,
		username: canaries.email.split("@")[0],
		password: "{{secret:password}}",
		phone: canaries.phone,
		cardNumber: "{{secret:cardNumber}}",
		cardExpiry: "12/30",
		cardCvc: "123",
		oneTimeCode: "{{secret:oneTimeCode}}",
		name: `Phishing Support ${canaries.marker}`,
		address: "123 Test Avenue",
		city: "Testville",
		postalCode: "10001",
		country: "United States",
		dateOfBirth: "1990-04-17",
		companyOrPageName: "Testville Studio",
	};
	return {
		goal: [
			`This is a controlled defensive investigation of a website someone reported as phishing or malware. The browser is already on its page (${url.toString()}). Go through the site the way a person it targets would, so that every step it shows is recorded.`,
			`Use only these synthetic values: ${JSON.stringify(syntheticValues)}. Type the {{secret:…}} placeholders exactly as written; the browser fills in their values. Never enter, request, or retrieve real personal data, credentials, messages, account content, or payment data.`,
			"Move past whatever stands before the site's main step, as a visitor would: a browser or hosting provider's warning page (for example Cloudflare's \"Suspected Phishing\" page: choose \"Ignore & Proceed\"), a cookie or consent banner, an age or region question, a \"continue\", \"verify\", or \"I'm not a robot\" button drawn by the page itself, or a dialog that hides the page.",
			`When the site asks for an email address, username, phone number, password, code, card, or personal details, fill every field with the semantically matching synthetic value and submit it. Continue through the site's own flow, including a repeated-password, one-time-code, or card stage. A field with no matching listed value (a date of birth split into day, month and year, a page or company name, a free-text reason) gets a plausible made-up value of the same kind; never stop because a value is missing. Tick a terms or consent checkbox the form requires. Kits often reject the first password or code as wrong: enter it again, up to three times, before treating the flow as blocked. Make at most ${MAX_FORM_SUBMISSIONS} form submissions in total.`,
			"When the site offers a download or install (a file, an app, a browser extension, an \"update\"), get that file once, the way a visitor would: a button often only opens a dialog, a second page, or a countdown that holds the actual download button (\"Download Game-Copier.zip\", \"Download now\", \"Get file\"), so keep going through those until a download starts, and do not count a click that only opened such a step. A dialog's buttons can be in the page before the dialog is shown (it is transparent until opened): when a click on such a button does nothing, open the dialog first with the page's own button that leads to it (\"Download\", \"Get …\"), then click the button inside it. Downloads are captured and blocked by the browser, so you may see no saved file or an error after the download starts; that is expected: stop trying once you have clicked the control that delivers the file itself. Never open, run, install, execute, extract, or interact with any downloaded file, and never enter data into one. If it asks you to copy or paste a command, do not run it; just leave it shown.",
			"Follow the site onto another domain only when its own form, redirect, frame, or button leads to the next step of the same flow. Do not follow advertisements, footer or social links, search results, or links to the impersonated brand's real website.",
			"A reCAPTCHA v2 or Cloudflare Turnstile checkbox is cleared automatically by the browser's guardian: do not click it yourself, and wait a few seconds for it to clear before acting. Do not authenticate to a real service, approve a real login or second factor, grant browser permissions, install extensions, change browser settings, or accept a dialog that installs software.",
			`Stop when the flow ends (a confirmation, an error, a page that asks for nothing more, or a redirect to the real brand's site), when it blocks the synthetic data, when a challenge is still present after waiting (such as hCaptcha or an image puzzle), when it asks to be opened on a phone instead (set asksForPhone), when the site is an ordinary site with nothing to submit or download, or after ${MAX_FORM_SUBMISSIONS} submissions. The visit has a time limit of about ${VISIT_BUDGET_MS / 60_000} minutes.`,
			...(instructions?.trim() ? [`For this visit, the investigator who asked for it adds: ${instructions.trim()} Follow that as well; every rule above on synthetic values and on never running, installing, or opening anything still applies.`] : []),
			"Finish with done and a short factual result; the pages, the network traffic, and the downloads are recorded independently. When the flow is blocked or asks for something you cannot give, that is also the end of the visit: finish with done and say so in stoppedReason.",
		].join("\n"),
		maxSteps,
		secrets,
		resultSchema: {
			type: "object",
			properties: {
				submissionsAttempted: { type: "integer", minimum: 0, maximum: MAX_FORM_SUBMISSIONS },
				downloadsStarted: { type: "integer", minimum: 0 },
				asksForPhone: { type: "boolean" },
				stoppedReason: { type: "string", maxLength: 300 },
			},
			required: ["submissionsAttempted", "downloadsStarted", "asksForPhone", "stoppedReason"],
			additionalProperties: false,
		},
	};
}

/** The agent's own report, or undefined when its output does not have that shape. */
export function visitAgentReport(output: unknown): VisitAgentReport | undefined {
	const report = output && typeof output === "object" ? output as Record<string, unknown> : undefined;
	if (!report || typeof report.stoppedReason !== "string") return undefined;
	return {
		submissionsAttempted: typeof report.submissionsAttempted === "number" ? report.submissionsAttempted : 0,
		downloadsStarted: typeof report.downloadsStarted === "number" ? report.downloadsStarted : 0,
		asksForPhone: report.asksForPhone === true,
		stoppedReason: report.stoppedReason.slice(0, 300),
	};
}
