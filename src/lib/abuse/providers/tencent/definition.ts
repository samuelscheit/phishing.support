import { hashStableJson } from "../../security";
import type { ProviderSubmissionDefinition } from "../submission_contracts";

/**
 * Code-owned Tencent Cloud DNS-abuse form contract. Secrets and runtime proxy
 * settings intentionally do not belong in this immutable, route-pinned record.
 */
export type TencentProviderDefinition = ProviderSubmissionDefinition & {
	reportPageUrl: string;
	submissionUrl: string;
	captcha: {
		provider: "death_by_captcha";
		type: 23;
		appId: string;
	};
	evidence: {
		requiredMimeType: "image/png";
		maximumBytes: number;
	};
	reporter: {
		name: string;
		email: string;
		countryCode: string;
		countryName: string;
	};
};

const definitionWithoutHash = {
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
		name: "Phishing Support",
		email: "support@phishing.support",
		countryCode: "DE",
		countryName: "Germany",
	},
};

export const TENCENT_PROVIDER: TencentProviderDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});
