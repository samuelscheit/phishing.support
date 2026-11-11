import { serviceIdentity } from "../../../constants";
import { hashStableJson } from "../../security";
import type { MailedCodeSpec } from "../mailed_code";
import type { ProviderSubmissionDefinition } from "../submission_contracts";

export type EranetProviderDefinition = ProviderSubmissionDefinition & {
	reportPageUrl: string;
	apiBaseUrl: string;
	/** The verification-code mail the form sends before it accepts a complaint. */
	codeMail: MailedCodeSpec;
	evidence: {
		acceptedMimeTypes: readonly ["image/png", "image/jpeg", "image/gif"];
		maximumBytes: number;
		uploadType: "reportPageScreenshot";
	};
	maximumDescriptionLength: number;
	/**
	 * `contact` fills the form's required "Contact Information" field (sent as
	 * `Phone`; empty is refused with `InvaildAbuseDomain.PhoneEmpty`). The
	 * service has no phone line, so it names the service mailbox.
	 */
	reporter: { email: string; contactType: "E"; contact: string };
};

/**
 * Code-owned contract for Eranet's "Fraud & Phishing Report" form
 * (www.eranet.com/panel/abuse/report/phishing-report/index), read from its
 * web bundle on 2026-11-03. Eranet (IANA 1868) publishes abuse@eranet.com in
 * the registry's RDAP, a mailbox its mail server rejects; the form is its
 * working abuse channel. The form mails a six-digit code to the reporter and
 * accepts the complaint only with it.
 */
const definitionWithoutHash = {
	key: "eranet",
	displayName: "Eranet Fraud & Phishing Report",
	version: "2026-11-07.1",
	exactMailboxes: ["abuse@eranet.com", "support@eranet.com", "support@tnet.hk", "cs@eranet.com"],
	registrarIds: [1868],
	supplemental: false,
	reportPageUrl: "https://www.eranet.com/panel/abuse/report/phishing-report/index",
	apiBaseUrl: "https://www.eranet.com/api/domain/abuse",
	codeMail: {
		provider: "Eranet",
		senderDomains: ["noreply.eranet.com"],
		subjectPattern: "verification code",
		codePattern: "verification code is:?\\s*(\\d{6})\\b",
		maxAgeMs: 10 * 60_000,
		waitMs: 3 * 60_000,
	},
	evidence: {
		acceptedMimeTypes: ["image/png", "image/jpeg", "image/gif"] as const,
		maximumBytes: 8 * 1024 * 1024,
		uploadType: "reportPageScreenshot" as const,
	},
	maximumDescriptionLength: 2_000,
	reporter: {
		email: serviceIdentity.mailbox,
		contactType: "E" as const,
		contact: serviceIdentity.mailbox,
	},
};

export const ERANET_PROVIDER: EranetProviderDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});
