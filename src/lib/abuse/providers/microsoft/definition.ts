import { serviceIdentity } from "../../../network/service_identity";
import { definePinned } from "../kit/pin";

/**
 * Code-owned contract for MSRC Report Abuse (api.msrc.microsoft.com/report/v3.0).
 * abuse@ and cert@microsoft.com are unmonitored; the portal needs no login,
 * captcha or cookies, so the route posts the JSON it does.
 */
export const MICROSOFT_PROVIDER = definePinned({
	key: "microsoft_msrc",
	displayName: "Microsoft MSRC Report Abuse",
	version: "2026-11-20.2",
	exactMailboxes: ["abuse@microsoft.com", "cert@microsoft.com"],
	supplemental: false,
	/** The MSRC Report Abuse API; the portal at `formUrl` is its only client and posts the same request unauthenticated. */
	endpoint: "https://api.msrc.microsoft.com/report/v3.0/abuse",
	/** The `origin` and `referer` the portal's own requests carry. */
	origin: "https://msrc.microsoft.com",
	formUrl: "https://msrc.microsoft.com/report/abuse?ThreatType=URL&IncidentType=Phishing",
	threatType: "URL" as const,
	/** The API's `threatType` for an address; `Spam` is its only incident type for unsolicited email, and only for addresses. */
	ipThreatType: "IP Address" as const,
	emailIncidentType: "Spam" as const,
	/** The API's `incidentType` per allegation (OpenAPI `AbuseIncidentType`). */
	incidentTypes: { phishing: "Phishing", malware: "Malware" },
	/** The value the anonymous portal sends; the API's `ReportApi` is untested unauthenticated. */
	source: "CertPortalV2" as const,
	/** The form allows at most this many URL items, one URL each, none containing whitespace or `,;|`. */
	maximumUrls: 10,
	urlMaximumLength: 2_048,
	/** `reportNotes` is at most this long. */
	notesMaximumLength: 2_000,
	/** The report narrative's share of the notes; the rest holds the reference, hosting line and case page. */
	narrativeMaximumLength: 1_200,
	/** The narrative of a report on an email's sending address leaves room for the Received header and links. */
	emailNarrativeMaximumLength: 800,
	emailReceivedMaximumLength: 300,
	hostingLineMaximumLength: 300,
	referenceMaximumLength: 50,
	timeoutMs: 30_000,
	/** The form's own `reporterEmail` limit. */
	reporterEmailMaximumLength: 64,
	reporter: {
		name: serviceIdentity.name,
		email: serviceIdentity.mailbox,
		organization: serviceIdentity.name,
		phoneNumber: "",
	},
});

