import { serviceIdentity } from "../../../constants";
import { hashStableJson } from "../../security";
import type { ProviderSubmissionDefinition } from "../submission_contracts";

export type GoDaddyProviderDefinition = ProviderSubmissionDefinition & {
	/** The official Abuse API (needs onboarding: GoDaddy answers 403 until the reporter is enabled). */
	api: {
		baseUrl: string;
		ticketsPath: string;
		/** Environment variables holding the Classic Developer Key (`Authorization: sso-key KEY:SECRET`). */
		keyVariable: string;
		secretVariable: string;
		timeoutMs: number;
		/** More URLs of one domain count against the reporter as duplicates. */
		maximumUrls: number;
		infoMaximumLength: number;
		targetMaximumLength: number;
		/** Ticket id as the API returns it (`DCU12345678`). */
		ticketPattern: string;
	};
	/** The Legal Portal's public phishing form, the channel while the API is not enabled. */
	portal: {
		formUrl: string;
		formSelector: string;
		submitUrl: string;
		caseStatusUrl: string;
		/** Sent by the page's own script; the portal answers 403 without it. */
		requestHeader: { name: string; value: string };
		cookieBannerAccept: string;
		recaptcha: { siteKey: string; action: string; scriptTimeoutMs: number };
		timeoutMs: number;
		/** The form's "country viewed from" default. */
		defaultCountry: string;
		/** Hidden inputs of the phishing form with the value the page sends when it renders none. */
		hiddenFields: readonly (readonly [name: string, value: string])[];
		/** Names of the hidden inputs the submission copies from the rendered page when present. */
		renderedFieldPattern: string;
		/** The portal's case id as GoDaddy mails it (the API's ticket ids look the same). */
		casePattern: string;
	};
	infoMaximumLength: number;
	/** Brand for the form's required field when the report names none. */
	unknownBrand: string;
	brandMaximumLength: number;
	hostingLineMaximumLength: number;
	narrativeMinimumLength: number;
	reporter: { name: string; email: string };
};

/**
 * Code-owned contract for GoDaddy's phishing intake. `abuse@godaddy.com` is
 * unmonitored (its auto-reply says so); GoDaddy takes reports through its
 * Abuse API and, for everyone else, through the Legal Portal form behind an
 * invisible reCAPTCHA v3. Both file one report per URL (the API) or per form
 * (the portal) for domains registered or hosted at GoDaddy; IANA registrar ID
 * 146 is GoDaddy.com, LLC (checked in RDAP for godaddy.com).
 */
const definitionWithoutHash = {
	key: "godaddy",
	displayName: "GoDaddy",
	version: "2026-11-21.1",
	exactMailboxes: ["abuse@godaddy.com"],
	registrarIds: [146],
	supplemental: false,
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
	unknownBrand: "Not specified",
	brandMaximumLength: 100,
	hostingLineMaximumLength: 400,
	narrativeMinimumLength: 300,
	reporter: { name: serviceIdentity.name, email: serviceIdentity.mailbox },
};

export const GODADDY_PROVIDER: GoDaddyProviderDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});
