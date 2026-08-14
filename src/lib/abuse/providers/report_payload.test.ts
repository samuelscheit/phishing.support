import { describe, expect, test } from "bun:test";

import {
	makeProviderExplanation,
	normalizeObservedUrlForDomain,
	normalizePublicDomainHttpUrl,
} from "./report_payload";

describe("shared supplemental-provider payload helpers", () => {
	test("normalizes only public-domain HTTP(S) URLs and binds observed URLs to their target", () => {
		expect(normalizePublicDomainHttpUrl("HTTPS://LOGIN.Example.COM/path#discarded")).toBe(
			"https://login.example.com/path",
		);
		expect(normalizePublicDomainHttpUrl("https://user:pass@example.com/")).toBeUndefined();
		expect(normalizeObservedUrlForDomain("https://login.example.com/collect", "example.com")).toBe(
			"https://login.example.com/collect",
		);
		expect(normalizeObservedUrlForDomain("https://unrelated.example.net/collect", "example.com")).toBeUndefined();
	});

	test("never exceeds a provider maximum when adding legal-brand context", () => {
		const explanation = makeProviderExplanation({
			description: "Credential theft.",
			legalBrandUrl: "https://brand.example.com/",
			legalBrandLabel: "A deliberately long legal brand context label that cannot fit the provider field",
			maximumLength: 24,
		});
		expect(explanation).toBeDefined();
		expect(explanation!.length).toBeLessThanOrEqual(24);
	});
});
