import { serviceIdentity } from "../../../constants";
import { hashStableJson } from "../../security";
import type { ProviderSubmissionDefinition } from "../submission_contracts";

export type PublicDomainRegistryProviderDefinition = ProviderSubmissionDefinition & {
	formUrl: string;
	/** The phishing form (Contact Form 7, id 643) among the page's forms. */
	formSelector: string;
	formId: string;
	/** Contact Form 7's REST endpoint for the form; the page posts its own request there. */
	feedbackUrl: string;
	/** The drag-and-drop uploader's endpoint; the form uploads a chosen file there at once. */
	uploadUrl: string;
	/** Page global holding the uploader's nonce. */
	uploadNonceGlobal: string;
	/** Names of the form's hidden and anti-spam inputs (`_wpcf7*`, `wpcf7_hp_field`, Akismet's), which the page renders and the submission copies as they are. */
	renderedFieldPattern: string;
	/** Rendered fields the submission refuses to go on without. */
	requiredRenderedFields: readonly string[];
	fields: { name: string; domain: string; complaint: string; email: string; upload: string; consent: string; turnstile: string };
	consent: string;
	complaintMaximumLength: number;
	/** A complaint's share for the reported URLs. */
	urlsMaximumLength: number;
	urlMaximumLength: number;
	maximumUrls: number;
	hostingLineMaximumLength: number;
	/** Below this the narrative has no room and the complaint is not drafted. */
	narrativeMinimumLength: number;
	/** The form's "Attachment (screenshot with time-stamp)": jpg/png, at most 5 000 000 bytes. */
	evidence: { acceptedMimeTypes: readonly ["image/png", "image/jpeg"]; maximumBytes: number };
	timeoutMs: number;
	reporter: { name: string; email: string };
};

/**
 * Code-owned contract for PublicDomainRegistry's phishing form. PDR's mailboxes
 * answer "No action will be taken until you have entered the report using our
 * online reporting form". The whole site sits behind a Cloudflare managed
 * challenge and the form carries a Turnstile widget, both of which only a real
 * Chrome passes, so the route files the report from inside such a browser.
 * IANA registrar ID 303 is PDR Ltd.
 */
const definitionWithoutHash = {
	key: "publicdomainregistry",
	displayName: "PublicDomainRegistry",
	version: "2026-11-21.1",
	exactMailboxes: ["abuse-contact@publicdomainregistry.com", "abuse@publicdomainregistry.com"],
	registrarIds: [303],
	supplemental: false,
	formUrl: "https://publicdomainregistry.com/phishing/",
	formSelector: 'form.wpcf7-form:has(input[name="_wpcf7"][value="643"])',
	formId: "643",
	feedbackUrl: "https://publicdomainregistry.com/wp-json/contact-form-7/v1/contact-forms/643/feedback",
	uploadUrl: "https://publicdomainregistry.com/wp-admin/admin-ajax.php",
	uploadNonceGlobal: "dnd_cf7_uploader.ajax_nonce",
	renderedFieldPattern: "^_?wpcf7",
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
	urlsMaximumLength: 700,
	urlMaximumLength: 500,
	maximumUrls: 10,
	hostingLineMaximumLength: 400,
	narrativeMinimumLength: 300,
	evidence: { acceptedMimeTypes: ["image/png", "image/jpeg"] as const, maximumBytes: 5_000_000 },
	timeoutMs: 60_000,
	reporter: { name: serviceIdentity.name, email: serviceIdentity.mailbox },
};

export const PUBLIC_DOMAIN_REGISTRY_PROVIDER: PublicDomainRegistryProviderDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});
