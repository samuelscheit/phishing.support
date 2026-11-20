import { serviceIdentity } from "../../../network/service_identity";
import { definePinned } from "../kit/pin";

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
export const NAME_COM_PROVIDER = definePinned({
	key: "name_com",
	displayName: "Name.com",
	version: "2026-11-21.1",
	exactMailboxes: ["abuse@name.com"],
	registrarIds: [625],
	supplemental: false,
	formUrl: "https://www.name.com/abuse",
	/** The abuse form among the page's forms: the only one with a textarea. */
	formSelector: "form:has(textarea)",
	/** The three required checkboxes' labels (their inputs are invisible); ticking them reveals the Turnstile widget. */
	checkboxSelector: "form:has(textarea) label.n-checkbox",
	checkboxCount: 3,
	turnstileWidgetSelector: ".cf-turnstile, iframe[src*='challenges.cloudflare.com']",
	/** Name.com's CSRF handshake: GET with `Time`, `Start` and `X-csrf-token-auth: sha256(Start + Time + Start)`. */
	csrfUrl: "https://www.name.com/csrf",
	csrfHeader: "x-csrf-token-auth",
	/** The solved Turnstile token is checked here, which flags the session as allowed to file. */
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
	/** Below this the narrative has no room and the report is not drafted. */
	narrativeMinimumLength: 300,
	/** The form's "Upload a file": `image/*`, at most 10 000 000 bytes, one file. */
	evidence: { acceptedMimeTypes: ["image/png", "image/jpeg"], maximumBytes: 10_000_000 },
	timeoutMs: 60_000,
	reporter: { ...reporterNames(serviceIdentity.name), email: serviceIdentity.mailbox },
});

