import { definePinned, serviceReporter } from "../kit/pin";

/**
 * Code-owned contract for GoDaddy's phishing intake. `abuse@godaddy.com` is
 * unmonitored (its auto-reply says so); GoDaddy takes reports through its
 * Abuse API and, for everyone else, through the Legal Portal form behind an
 * invisible reCAPTCHA v3. Both file one report per URL (the API) or per form
 * (the portal) for domains registered or hosted at GoDaddy; IANA registrar ID
 * 146 is GoDaddy.com, LLC (checked in RDAP for godaddy.com).
 */
export const GODADDY_PROVIDER = definePinned({
	key: "godaddy",
	displayName: "GoDaddy",
	version: "2026-11-21.1",
	exactMailboxes: ["abuse@godaddy.com"],
	registrarIds: [146],
	supplemental: false,
	/** The official Abuse API (needs onboarding: GoDaddy answers 403 until the reporter is enabled). */
	api: {
		baseUrl: "https://api.godaddy.com",
		ticketsPath: "/v2/abuse/tickets",
		keyVariable: "GODADDY_ABUSE_API_KEY",
		secretVariable: "GODADDY_ABUSE_API_SECRET",
		timeoutMs: 30_000,
		maximumUrls: 5,
		infoMaximumLength: 20_050,
		targetMaximumLength: 2_000,
		ticketPattern: "DCU\\d{6,12}",
	},
	/** The Legal Portal's public phishing form, the channel while the API is not enabled. */
	portal: {
		formUrl: "https://legalportal.godaddy.com/abuse/phishing",
		formSelector: "form:has(#source-field)",
		submitUrl: "https://legalportal.godaddy.com/api/v1/submit/abuse",
		caseStatusUrl: "https://legalportal.godaddy.com/api/v1/case-status",
		requestHeader: { name: "X-Portal-Request", value: "1" },
		cookieBannerAccept: "#pw_accept",
		recaptcha: { siteKey: "6Lcds5YsAAAAAOxWlnaB1W5e1KIAmk2AhXuUpe97", action: "submit_abuse_report", scriptTimeoutMs: 30_000 },
		timeoutMs: 60_000,
		defaultCountry: "N/A",
		hiddenFields: [["contact_name", ""], ["url", "[]"], ["email_headers", ""], ["intentional", "false"], ["form_plid", "1"], ["electronic_signature", ""]] as const,
		renderedFieldPattern: "^(type|contact_name|url|email_headers|intentional|form_plid|electronic_signature)$",
		casePattern: "DCU\\d{6,12}",
	},
	infoMaximumLength: 6_000,
	/** Brand for the form's required field when the report names none. */
	unknownBrand: "Not specified",
	brandMaximumLength: 100,
	hostingLineMaximumLength: 400,
	narrativeMinimumLength: 300,
	reporter: serviceReporter,
});

export type GoDaddyProviderDefinition = typeof GODADDY_PROVIDER;
