import { definePinned, serviceReporter } from "../kit/pin";

/**
 * Code-owned contract for DigitalOcean's abuse form
 * (https://www.digitalocean.com/company/contact/abuse). abuse@digitalocean.com
 * is read by tooling that only parses XARF reports and points everything else
 * to the form. The form's one request is an unauthenticated multipart POST
 * without captcha; the API answers 201 with no body when it keeps the report
 * and 422 when it refuses it (only the reporter email is required server-side,
 * so a report without a known source IP is accepted).
 */
export const DIGITALOCEAN_PROVIDER = definePinned({
	key: "digitalocean",
	displayName: "DigitalOcean",
	version: "2026-11-22.1",
	exactMailboxes: ["abuse@digitalocean.com"],
	supplemental: false,
	/** When the form refuses a report, the mailbox still gets it as XARF, the only mail its tooling processes. */
	emailFallback: { format: "xarf" },
	formUrl: "https://www.digitalocean.com/company/contact/abuse",
	endpoint: "https://inbound.digitalocean.com/contact_forms/abuse_reports",
	/** The `origin` and `referer` the form's own request carries. */
	origin: "https://www.digitalocean.com",
	/** The form's `abuse_type` per allegation. */
	abuseTypes: { phishing: "phishing", malware: "malware" },
	/** Every field is sent as `abuse_report[<name>]`. */
	fields: {
		name: "reporter_name",
		email: "email",
		campaignTarget: "phishing_campaign_target",
		evidenceUrl: "evidence_urls",
		sourceIp: "source_ip",
		/** The malware form's required "Evidence or logs showing the source IP". */
		abuseEvidence: "abuse_evidence",
		date: "date",
		time: "time",
		timezone: "timezone",
		details: "additional_information",
		abuseType: "abuse_type",
		affirmation: "affirmation_check",
	},
	/** The form's timezone option for UTC. */
	timezone: "+00:00",
	affirmationValue: "1",
	/** "Target of the phishing campaign" when the report names no brand. */
	unknownCampaignTarget: "Unknown",
	inputMaximumLength: 255,
	urlMaximumLength: 2_048,
	detailsMaximumLength: 5_000,
	urlsMaximumLength: 1_500,
	maximumUrls: 10,
	hostingLineMaximumLength: 600,
	narrativeMinimumLength: 300,
	timeoutMs: 30_000,
	reporter: serviceReporter,
});
