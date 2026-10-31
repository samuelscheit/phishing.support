import { serviceIdentity } from "../../../constants";
import { hashStableJson } from "../../security";
import type { ProviderSubmissionDefinition } from "../submission_contracts";

/** The form's "Google Cloud Platform Service" radio values. */
export const GOOGLE_CLOUD_SERVICES = ["n_a", "google_app_engine", "compute_engine", "cloud_storage"] as const;
export type GoogleCloudService = (typeof GOOGLE_CLOUD_SERVICES)[number];

export type GoogleCloudProviderDefinition = ProviderSubmissionDefinition & {
	reportPageUrl: string;
	/** The help-center endpoint the form posts to; its JSON response says whether a case was created. */
	submitEndpointPath: string;
	abuseDetailsMaximumLength: number;
	reporter: {
		email: string;
	};
};

/**
 * Code-owned contract for Google's "Report suspected abuse on Google Cloud
 * Platform" form. Both Google Cloud abuse mailboxes send reporters there:
 * network-abuse@ auto-replies with the form link, and
 * google-cloud-compliance@ asks for the date and address the form collects.
 */
const definitionWithoutHash = {
	key: "google_cloud",
	displayName: "Google Cloud Abuse Report",
	version: "2026-10-31.1",
	exactMailboxes: ["network-abuse@google.com", "google-cloud-compliance@google.com"],
	supplemental: false,
	reportPageUrl: "https://support.google.com/code/contact/cloud_platform_report?hl=en",
	submitEndpointPath: "/apis/cufinsert",
	abuseDetailsMaximumLength: 1_000,
	reporter: {
		email: serviceIdentity.mailbox,
	},
};

export const GOOGLE_CLOUD_PROVIDER: GoogleCloudProviderDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});
