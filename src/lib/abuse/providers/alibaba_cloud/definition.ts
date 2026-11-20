import { serviceIdentity } from "../../../constants";
import { hashStableJson } from "../../security";
import type { MailedCodeSpec } from "../mailed_code";
import type { ProviderSubmissionDefinition } from "../submission_contracts";

export type AlibabaCloudProviderDefinition = ProviderSubmissionDefinition & {
	/** The Reporting Center console whose OpenAPI the form calls (`/data/api.json`). */
	consoleOrigin: string;
	/** The console product the report actions belong to. */
	apiProduct: string;
	/** The form's page type: "Illegal Information Reporting". */
	pageType: "harmInfo";
	loginUrl: string;
	/** The mail with the code Alibaba's login asks for from a new browser. */
	codeMail: MailedCodeSpec;
	/** The form's "Report Type" option per allegation; the values are the form's English labels. */
	reportTypes: { phishing: string; malware: string };
	carrier: string;
	/** `reportDomainIp` holds one URL, domain or IP of at most this many characters. */
	reportObjectMaximumLength: number;
	reportReasonMaximumLength: number;
	evidence: {
		acceptedMimeTypes: readonly ["image/png", "image/jpeg"];
		/** The form allows 50 MB; screenshots stay far below it. */
		maximumBytes: number;
	};
	/** The "Victim (URL/domain name/IP)" field when the report names no impersonated brand URL. */
	victimFallback: string;
	reporter: { name: string; email: string; area: string };
};

/**
 * Code-owned contract for the Alibaba Cloud Reporting Center
 * (report.alibabacloud.com, linked from alibabacloud.com/report). Every report
 * form there needs a logged-in Alibaba Cloud account, so reports are filed
 * through the console API with the service's own account session. The
 * mailboxes Alibaba names for people who cannot log in, and the hosting abuse
 * mailbox its IP space's RDAP records name, select this form instead of mail.
 */
const definitionWithoutHash = {
	key: "alibaba_cloud",
	displayName: "Alibaba Cloud Reporting Center",
	version: "2026-11-20.1",
	// report.alibabacloud.com: "If you cannot log in, please send your complaint
	// request to infosec@service.aliyun.com or domainabuse@service.aliyun.com."
	exactMailboxes: ["domainabuse@service.aliyun.com", "infosec@service.aliyun.com", "abuse@alibaba-inc.com"],
	supplemental: false,
	consoleOrigin: "https://report.alibabacloud.com",
	apiProduct: "abusereport",
	pageType: "harmInfo" as const,
	loginUrl: "https://account.alibabacloud.com/login/login.htm?oauth_callback=https%3A%2F%2Freport.alibabacloud.com%2F",
	codeMail: {
		provider: "Alibaba Cloud",
		// 2026-11-20: "Verification Code from Alibaba Group" from system-sg@notice.alibabacloud.com.
		senderDomains: ["alibabacloud.com"],
		subjectPattern: "verification code",
		// "Please enter the code to verify your account. 346070"
		codePattern: "verify your account\\.?\\s*(\\d{6})\\b",
		maxAgeMs: 30 * 60_000,
		waitMs: 3 * 60_000,
	},
	reportTypes: { phishing: "Phishing Scams", malware: "Illegal Activities" },
	carrier: "Website",
	reportObjectMaximumLength: 200,
	reportReasonMaximumLength: 1_000,
	evidence: {
		acceptedMimeTypes: ["image/png", "image/jpeg"] as const,
		maximumBytes: 20 * 1024 * 1024,
	},
	victimFallback: "Visitors of the reported page (unknown individual victims)",
	reporter: { name: serviceIdentity.name, email: serviceIdentity.mailbox, area: serviceIdentity.countryName },
};

export const ALIBABA_CLOUD_PROVIDER: AlibabaCloudProviderDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});
