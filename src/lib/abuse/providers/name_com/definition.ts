import { serviceIdentity } from "../../../constants";
import { hashStableJson } from "../../security";
import type { ProviderSubmissionDefinition } from "../submission_contracts";

export type NameComProviderDefinition = ProviderSubmissionDefinition & {
	formUrl: string;
	/** The abuse form among the page's forms: the only one with a textarea. */
	formSelector: string;
	/** The three required checkboxes' labels (their inputs are invisible); ticking them reveals the Turnstile widget. */
	checkboxSelector: string;
	checkboxCount: number;
	turnstileWidgetSelector: string;
	/** Name.com's CSRF handshake: GET with `Time`, `Start` and `X-csrf-token-auth: sha256(Start + Time + Start)`. */
	csrfUrl: string;
	csrfHeader: string;
	/** The solved Turnstile token is checked here, which flags the session as allowed to file. */
	verifyCaptchaUrl: string;
	submitUrl: string;
	formType: string;
	infringementType: string;
	fields: { formType: string; firstName: string; lastName: string; email: string; attachment: string; domain: string; infringement: string; additional: string; agree: string; mayNotRespond: string };
	additionalMaximumLength: number;
	urlsMaximumLength: number;
	urlMaximumLength: number;
	maximumUrls: number;
	hostingLineMaximumLength: number;
	/** Below this the narrative has no room and the report is not drafted. */
	narrativeMinimumLength: number;
	/** The form's "Upload a file": `image/*`, at most 10 000 000 bytes, one file. */
	evidence: { acceptedMimeTypes: readonly ["image/png", "image/jpeg"]; maximumBytes: number };
	timeoutMs: number;
	reporter: { firstName: string; lastName: string; email: string };
};

/** "Phishing Support" → first name "Phishing", last name "Support": the form wants both. */
function reporterNames(name: string): { firstName: string; lastName: string } {
	const index = name.lastIndexOf(" ");
	return index < 0 ? { firstName: name, lastName: name } : { firstName: name.slice(0, index), lastName: name.slice(index + 1) };
}

/**
 * Code-owned contract for Name.com's Report Abuse form (a Zendesk ticket
 * creator behind a Nuxt SPA). The whole site sits behind a Cloudflare managed
 * challenge, the form carries a Turnstile widget and every API call needs a
 * CSRF token from a handshake, so the route files the report from inside a
 * real Chrome. Name.com acts only as registrar (IANA ID 625) or hosting provider.
 * abuse@name.com is quoted by third parties but auto-replies "not monitored".
 */
const definitionWithoutHash = {
	key: "name_com",
	displayName: "Name.com",
	version: "2026-11-21.1",
	exactMailboxes: ["abuse@name.com"],
	registrarIds: [625],
	supplemental: false,
	formUrl: "https://www.name.com/abuse",
	formSelector: "form:has(textarea)",
	checkboxSelector: "form:has(textarea) label.n-checkbox",
	checkboxCount: 3,
	turnstileWidgetSelector: ".cf-turnstile, iframe[src*='challenges.cloudflare.com']",
	csrfUrl: "https://www.name.com/csrf",
	csrfHeader: "x-csrf-token-auth",
	verifyCaptchaUrl: "https://www.name.com/api/v5/account/verify_recaptcha",
	submitUrl: "https://www.name.com/ajax/zendeskticket/create/",
	formType: "report_abuse_spa",
	infringementType: "Phishing",
	fields: {
		formType: "form-type",
		firstName: "firstname",
		lastName: "lastname",
		email: "email",
		attachment: "attachment",
		domain: "domain_name",
		infringement: "typeofinfringement",
		additional: "additional",
		agree: "iagree",
		mayNotRespond: "maynotrespond",
	},
	additionalMaximumLength: 2_000,
	urlsMaximumLength: 700,
	urlMaximumLength: 500,
	maximumUrls: 10,
	hostingLineMaximumLength: 400,
	narrativeMinimumLength: 300,
	evidence: { acceptedMimeTypes: ["image/png", "image/jpeg"] as const, maximumBytes: 10_000_000 },
	timeoutMs: 60_000,
	reporter: { ...reporterNames(serviceIdentity.name), email: serviceIdentity.mailbox },
};

export const NAME_COM_PROVIDER: NameComProviderDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});
