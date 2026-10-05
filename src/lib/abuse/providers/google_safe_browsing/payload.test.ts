import { describe, expect, test } from "bun:test";

import { providerDefinitionHasValidHash } from "../definition";
import { GOOGLE_SAFE_BROWSING_PROVIDER } from "./definition";
import { buildGoogleSafeBrowsingSubmissionPayload, makeGoogleSafeBrowsingExplanation, storedGoogleSafeBrowsingSubmissionPayload } from "./payload";

describe("Google Safe Browsing submission payload", () => {
	test("pins a reviewed supplemental provider definition", () => {
		expect(GOOGLE_SAFE_BROWSING_PROVIDER.supplemental).toBeTrue();
		expect(GOOGLE_SAFE_BROWSING_PROVIDER.exactMailboxes).toEqual([]);
		expect(providerDefinitionHasValidHash(GOOGLE_SAFE_BROWSING_PROVIDER)).toBeTrue();
	});

	test("uses standalone evidence and legal-brand context without a legacy draft", () => {
		const explanation = makeGoogleSafeBrowsingExplanation({
			description: `  ${"credential theft on a fake sign-in form ".repeat(80)} `,
			legalBrandUrl: "https://brand.example.com/legitimate-service",
		});
		expect(explanation).toContain("Impersonated brand: https://brand.example.com/legitimate-service");
		expect(explanation!.length).toBeLessThanOrEqual(GOOGLE_SAFE_BROWSING_PROVIDER.explanationMaximumLength);

		const payload = buildGoogleSafeBrowsingSubmissionPayload({
			target: "phishing.example.com",
			observedUrl: "https://login.phishing.example.com/collect#discarded",
			description: "The page harvests credentials while impersonating the protected brand.",
			legalBrandUrl: "https://brand.example.com/",
		});
		expect(payload).toMatchObject({
			adapter: "google_safe_browsing_phish_v1",
			target: { normalizedTarget: "phishing.example.com", observedUrl: "https://login.phishing.example.com/collect" },
		});
		expect(storedGoogleSafeBrowsingSubmissionPayload(payload)).toEqual(payload);
	});

	test("refuses a URL outside the resolved domain route", () => {
		expect(buildGoogleSafeBrowsingSubmissionPayload({
			target: "phishing.example.com",
			observedUrl: "https://unrelated.example.com/collect",
			description: "Credential theft.",
		})).toBeUndefined();
	});
});
