import { hashStableJson } from "../../security";
import type { ProviderSubmissionDefinition } from "../submission_contracts";

/** Code-owned contract for Google's supplemental phishing-report form. */
export type GoogleSafeBrowsingProviderDefinition = ProviderSubmissionDefinition & {
	reportPageUrl: string;
	maximumSubmitAttempts: number;
	explanationMaximumLength: number;
	recaptcha: {
		siteKey: string;
		minimumScore: number;
		action: string;
	};
};

const definitionWithoutHash = {
	key: "google_safe_browsing",
	displayName: "Google Safe Browsing",
	version: "2026-08-14.1",
	exactMailboxes: [],
	supplemental: true,
	supplementalTargets: [{ targetType: "domain" as const, requiresObservedUrl: true as const }],
	reportPageUrl: "https://safebrowsing.google.com/safebrowsing/report_phish/",
	maximumSubmitAttempts: 2,
	explanationMaximumLength: 800,
	recaptcha: {
		siteKey: "6LdyJYcqAAAAAIkFpjuB7uz9WgDXmMECefi-8X-d",
		minimumScore: 0.9,
		action: "submitUrl",
	},
};

export const GOOGLE_SAFE_BROWSING_PROVIDER: GoogleSafeBrowsingProviderDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});
