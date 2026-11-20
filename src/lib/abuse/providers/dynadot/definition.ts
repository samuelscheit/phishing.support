import { definePinned, serviceReporter } from "../kit/pin";

/**
 * Code-owned contract for Dynadot's abuse form (https://www.dynadot.com/report-abuse).
 * Dynadot's abuse@ mailbox is not monitored; the form is the intended channel.
 * The whole site sits behind a Cloudflare managed challenge and the form carries
 * a Turnstile widget, which only a real Chrome passes, so the route files the
 * report from inside such a browser. IANA registrar ID 472 is Dynadot Inc.
 */
export const DYNADOT_PROVIDER = definePinned({
	key: "dynadot",
	displayName: "Dynadot",
	version: "2026-11-21.1",
	exactMailboxes: ["abuse@dynadot.com"],
	registrarIds: [472],
	supplemental: false,
	formUrl: "https://www.dynadot.com/report-abuse",
	/** The abuse type's `<select>`, outside the `<form>`: present once the page has rendered. */
	abuseTypeSelector: "#id-abuse-type-select",
	/** The phishing form, rendered once the abuse type is chosen. */
	formSelector: 'form:has([name="domains_2"])',
	/** The abuse type "Phishing" of the form's select. */
	abuseType: "2",
	/** The one request the form makes; Cloudflare's challenge covers the API path too, so it is posted from inside the page. */
	submitUrl: "https://www.dynadot.com/dynadot-vue-api/dynadot-service/main-site-api?command=submit_abuse&lang=en",
	headers: { "content-language": "en", "dyna-client-type": "Web" },
	/** The Turnstile container, which the page renders once the abuse type is chosen. */
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
	/** Answer for the form's "not applicable" inputs. */
	notApplicable: "N/A",
	/** `maxlength` of the form's text inputs. */
	inputMaximumLength: 255,
	commentsMaximumLength: 3_000,
	urlsMaximumLength: 900,
	maximumUrls: 10,
	hostingLineMaximumLength: 400,
	/** Below this the narrative has no room and the comment is not drafted. */
	narrativeMinimumLength: 300,
	/** The form takes up to 8 files of any type, 100 MB in all; one screenshot is sent. */
	evidence: { acceptedMimeTypes: ["image/png", "image/jpeg"] as const, maximumBytes: 5_000_000 },
	timeoutMs: 60_000,
	reporter: serviceReporter,
});

export type DynadotProviderDefinition = typeof DYNADOT_PROVIDER;
