import { serviceIdentity } from "../../../network/service_identity";
import { definePinned } from "../kit/pin";

/**
 * Code-owned Tencent Cloud DNS-abuse form contract. Secrets and runtime proxy
 * settings intentionally do not belong in this immutable, route-pinned record.
 */

export const TENCENT_PROVIDER = definePinned({
	key: "tencent",
	displayName: "Tencent Cloud Domain Abuse",
	version: "2026-08-14.1",
	exactMailboxes: ["dnsabuse_complaint@tencent.com"],
	supplemental: false,
	reportPageUrl: "https://www.tencentcloud.com/report-platform/dnsabuse",
	submissionUrl: "https://www.tencentcloud.com/main/ajax/reportDsaPlatform/createDomainReport",
	captcha: {
		provider: "death_by_captcha" as const,
		type: 23 as const,
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

