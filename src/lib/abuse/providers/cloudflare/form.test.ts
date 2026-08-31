import { describe, expect, test } from "bun:test";

import { buildCloudflareFormPayload } from "./form";

const serviceIdentity = {
	name: "Phishing Support",
	mailbox: "support@phishing.support",
	organizationUrl: "https://phishing.support/",
	reportedCountry: "DE",
};

describe("buildCloudflareFormPayload", () => {
	test("includes the standalone allegation and reviewed DSA controls", () => {
		const payload = buildCloudflareFormPayload({
			serviceIdentity,
			target: "example.com",
			observedUrl: "https://login.example.com/collect",
			description: "The page impersonates the protected brand and captures login credentials.",
			legalBrandUrl: "https://brand.example.com/",
		});

		expect(payload).toMatchObject({
			email: "support@phishing.support",
			emailConfirmation: "support@phishing.support",
			urls: "https://login.example.com/collect",
			originalWork: "https://brand.example.com/",
			dsaAttestation: true,
			dsaCertification: true,
		});
		expect(payload.justification).toContain("Observed URL: https://login.example.com/collect");
		expect(payload.justification).toContain("Legitimate brand URL: https://brand.example.com/");
		expect(payload.justification).toContain("captures login credentials");
	});

	test("bounds untrusted report text without dropping the URL controls", () => {
		const payload = buildCloudflareFormPayload({
			serviceIdentity,
			target: "example.com",
			observedUrl: "https://example.com/collect",
			description: "x".repeat(10_000),
		});

		expect(payload.justification.length).toBeLessThanOrEqual(3_000);
		expect(payload.justification).toStartWith("Phishing report for example.com.");
		expect(payload.justification).toContain("Observed URL: https://example.com/collect");
	});
});
