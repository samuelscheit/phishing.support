import { definePinned, serviceReporter } from "../kit/pin";

/**
 * Code-owned contract for PublicDomainRegistry's phishing form. PDR's mailboxes
 * answer "No action will be taken until you have entered the report using our
 * online reporting form". The whole site sits behind a Cloudflare managed
 * challenge and the form carries a Turnstile widget, both of which only a real
 * Chrome passes, so the route files the report from inside such a browser.
 * IANA registrar ID 303 is PDR Ltd.
 */
export const PUBLIC_DOMAIN_REGISTRY_PROVIDER = definePinned({
	key: "publicdomainregistry",
	displayName: "PublicDomainRegistry",
	version: "2026-11-21.1",
	exactMailboxes: ["abuse-contact@publicdomainregistry.com", "abuse@publicdomainregistry.com"],
	registrarIds: [303],
	supplemental: false,
	formUrl: "https://publicdomainregistry.com/phishing/",
	/** The phishing form (Contact Form 7, id 643) among the page's forms. */
	formSelector: 'form.wpcf7-form:has(input[name="_wpcf7"][value="643"])',
	formId: "643",
	/** Contact Form 7's REST endpoint for the form; the page posts its own request there. */
	feedbackUrl: "https://publicdomainregistry.com/wp-json/contact-form-7/v1/contact-forms/643/feedback",
	/** The drag-and-drop uploader's endpoint; the form uploads a chosen file there at once. */
	uploadUrl: "https://publicdomainregistry.com/wp-admin/admin-ajax.php",
	/** Page global holding the uploader's nonce. */
	uploadNonceGlobal: "dnd_cf7_uploader.ajax_nonce",
	/** Names of the form's hidden and anti-spam inputs (`_wpcf7*`, `wpcf7_hp_field`, Akismet's), which the page renders and the submission copies as they are. */
	renderedFieldPattern: "^_?wpcf7",
	/** Rendered fields the submission refuses to go on without. */
	requiredRenderedFields: ["_wpcf7", "_wpcf7_version", "_wpcf7_locale", "_wpcf7_unit_tag", "_wpcf7_container_post"],
	fields: {
		name: "your-name",
		domain: "text-748",
		complaint: "textarea-66",
		email: "your-email",
		upload: "upload-file-448[]",
		consent: "gdpr-privacy-policy[]",
		turnstile: "cf-turnstile-response",
	},
	consent: "I agree to the Terms of Service and the Privacy Notice",
	complaintMaximumLength: 2_000,
	/** A complaint's share for the reported URLs. */
	urlsMaximumLength: 700,
	urlMaximumLength: 500,
	maximumUrls: 10,
	hostingLineMaximumLength: 400,
	/** Below this the narrative has no room and the complaint is not drafted. */
	narrativeMinimumLength: 300,
	/** The form's "Attachment (screenshot with time-stamp)": jpg/png, at most 5 000 000 bytes. */
	evidence: { acceptedMimeTypes: ["image/png", "image/jpeg"] as const, maximumBytes: 5_000_000 },
	timeoutMs: 60_000,
	reporter: serviceReporter,
});

export type PublicDomainRegistryProviderDefinition = typeof PUBLIC_DOMAIN_REGISTRY_PROVIDER;
