import { serviceIdentity } from "../../../constants";
import { definePinned } from "../kit/pin";

/** The form's "Google Cloud Platform Service" radio values. */
export const GOOGLE_CLOUD_SERVICES = ["n_a", "google_app_engine", "compute_engine", "cloud_storage"] as const;
export type GoogleCloudService = (typeof GOOGLE_CLOUD_SERVICES)[number];

/**
 * Code-owned contract for Google's "Report suspected abuse on Google Cloud
 * Platform" form. Both Google Cloud abuse mailboxes send reporters there:
 * network-abuse@ auto-replies with the form link, and
 * google-cloud-compliance@ asks for the date and address the form collects.
 */
export const GOOGLE_CLOUD_PROVIDER = definePinned({
	key: "google_cloud",
	displayName: "Google Cloud Abuse Report",
	version: "2026-11-20.1",
	exactMailboxes: ["network-abuse@google.com", "google-cloud-compliance@google.com"],
	supplemental: false,
	reportPageUrl: "https://support.google.com/code/contact/cloud_platform_report?hl=en",
	/** The help-center endpoint the form posts to; its JSON response says whether a case was created. */
	submitEndpointPath: "/apis/cufinsert",
	/** The checkbox reCAPTCHA the form falls back to when its invisible check does not pass. */
	captcha: {
		provider: "death_by_captcha" as const,
		type: 4 as const,
		siteKey: "6LdZHQYTAAAAAFnofYfPjNlXpxWAqTwfLh9d0zL2",
	},
	abuseDetailsMaximumLength: 1_000,
	reporter: {
		email: serviceIdentity.mailbox,
	},
});

