import { serviceIdentity } from "../../../network/service_identity";
import { definePinned } from "../kit/pin";

/**
 * Code-owned Tencent Cloud DNS-abuse form contract. It is filed anonymously from a
 * direct-egress browser; no secrets or proxy settings belong in this immutable, route-pinned record.
 */

export const TENCENT_PROVIDER = definePinned({
	key: "tencent",
	displayName: "Tencent Cloud Domain Abuse",
	version: "2026-11-20.1",
	exactMailboxes: ["dnsabuse_complaint@tencent.com"],
	supplemental: false,
	reportPageUrl: "https://www.tencentcloud.com/report-platform/dnsabuse",
	submissionUrl: "https://www.tencentcloud.com/main/ajax/reportDsaPlatform/createDomainReport",
	/** The form's own slide puzzle (Tencent TCaptcha), solved in the browser that files the report. */
	captcha: {
		provider: "slider_puzzle" as const,
		appId: "2070586963",
	},
	evidence: {
		requiredMimeType: "image/png" as const,
		maximumBytes: 5 * 1024 * 1024,
	},
	reporter: {
		name: serviceIdentity.name,
		email: serviceIdentity.mailbox,
		countryCode: serviceIdentity.countryCode,
		countryName: serviceIdentity.countryName,
	},
});

