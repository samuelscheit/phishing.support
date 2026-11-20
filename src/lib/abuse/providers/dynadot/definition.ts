import { serviceIdentity } from "../../../constants";
import { hashStableJson } from "../../security";
import type { ProviderSubmissionDefinition } from "../submission_contracts";

export type DynadotProviderDefinition = ProviderSubmissionDefinition & {
	formUrl: string;
	/** The abuse type's `<select>`, outside the `<form>`: present once the page has rendered. */
	abuseTypeSelector: string;
	/** The phishing form, rendered once the abuse type is chosen. */
	formSelector: string;
	/** The abuse type "Phishing" of the form's select. */
	abuseType: string;
	/** The one request the form makes; Cloudflare's challenge covers the API path too, so it is posted from inside the page. */
	submitUrl: string;
	headers: Readonly<Record<string, string>>;
	/** The Turnstile container, which the page renders once the abuse type is chosen. */
	turnstileWidgetSelector: string;
	fields: {
		name: string;
		email: string;
		emailConfirmation: string;
		phone: string;
		domain: string;
		officialWebsite: string;
		proxyLocations: string;
		domainPath: string;
		comments: string;
		/** `abuse_file_<index>_2`. */
		uploadPrefix: string;
		uploadSuffix: string;
		turnstile: string;
		submit: string;
		abuseType: string;
	};
	submitValue: string;
	/** Answer for the form's "not applicable" inputs. */
	notApplicable: string;
	/** `maxlength` of the form's text inputs. */
	inputMaximumLength: number;
	commentsMaximumLength: number;
	urlsMaximumLength: number;
	maximumUrls: number;
	hostingLineMaximumLength: number;
	/** Below this the narrative has no room and the comment is not drafted. */
	narrativeMinimumLength: number;
	/** The form takes up to 8 files of any type, 100 MB in all; one screenshot is sent. */
	evidence: { acceptedMimeTypes: readonly ["image/png", "image/jpeg"]; maximumBytes: number };
	timeoutMs: number;
	reporter: { name: string; email: string };
};

/**
 * Code-owned contract for Dynadot's abuse form (https://www.dynadot.com/report-abuse).
 * Dynadot's abuse@ mailbox is not monitored; the form is the intended channel.
 * The whole site sits behind a Cloudflare managed challenge and the form carries
 * a Turnstile widget, which only a real Chrome passes, so the route files the
 * report from inside such a browser. IANA registrar ID 472 is Dynadot Inc.
 */
const definitionWithoutHash = {
	key: "dynadot",
	displayName: "Dynadot",
	version: "2026-11-21.1",
	exactMailboxes: ["abuse@dynadot.com"],
	registrarIds: [472],
	supplemental: false,
	formUrl: "https://www.dynadot.com/report-abuse",
	abuseTypeSelector: "#id-abuse-type-select",
	formSelector: 'form:has([name="domains_2"])',
	abuseType: "2",
	submitUrl: "https://www.dynadot.com/dynadot-vue-api/dynadot-service/main-site-api?command=submit_abuse&lang=en",
	headers: { "content-language": "en", "dyna-client-type": "Web" },
	turnstileWidgetSelector: "#report-abuse-challenge",
	fields: {
		name: "full_name_2",
		email: "email_2",
		emailConfirmation: "email2_2",
		phone: "phone_2",
		domain: "domains_2",
		officialWebsite: "official_website_2",
		proxyLocations: "proxy_locations_2",
		domainPath: "domain_path_2",
		comments: "comments_2",
		uploadPrefix: "abuse_file_",
		uploadSuffix: "_2",
		turnstile: "cf-turnstile-response",
		submit: "save_form_2",
		abuseType: "abuse_type",
	},
	submitValue: "Submit",
	notApplicable: "N/A",
	inputMaximumLength: 255,
	commentsMaximumLength: 3_000,
	urlsMaximumLength: 900,
	maximumUrls: 10,
	hostingLineMaximumLength: 400,
	narrativeMinimumLength: 300,
	evidence: { acceptedMimeTypes: ["image/png", "image/jpeg"] as const, maximumBytes: 5_000_000 },
	timeoutMs: 60_000,
	reporter: { name: serviceIdentity.name, email: serviceIdentity.mailbox },
};

export const DYNADOT_PROVIDER: DynadotProviderDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});
