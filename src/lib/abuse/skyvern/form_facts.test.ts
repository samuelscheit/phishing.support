import { describe, expect, test } from "bun:test";

import { deriveProviderFormFacts } from "./form_facts";
import { buildGenericProviderFormTaskPayload } from "./task_payloads";

/** The analysis stored for production's Swiss Capital loan-scam report. */
const swissCapitalAnalysis = "## Verdict: **Likely phishing / fraudulent loan website**\nThe site `https://swisscapitalloans.sc-sec.online/` impersonates **Swiss Capital**.\nProbable legitimate site: **https://swisscapitalcorp.com/**";

const extracted = {
	impersonatedBrand: "Swiss Capital Corp",
	brandOfficialWebsite: "https://swisscapitalcorp.com/",
	attackSummary: "The page poses as Swiss Capital and collects loan applicants' identity and bank details.",
	dataTargeted: ["full name", "bank account", "identity document"],
};

describe("provider form facts from the phishing analysis", () => {
	test("carry the impersonated brand and its official website into the form payload", async () => {
		const facts = await deriveProviderFormFacts({ target: "swisscapitalloans.sc-sec.online", analysis: swissCapitalAnalysis }, async (input) => {
			expect(input.analysis).toBe(swissCapitalAnalysis);
			return extracted;
		});
		expect(facts).toEqual(extracted);

		const payload = buildGenericProviderFormTaskPayload({
			entryUrl: "https://www.dynadot.com/community/contact",
			allowedDomains: ["dynadot.com"],
			target: "swisscapitalloans.sc-sec.online",
			allegationCategory: "phishing",
			description: swissCapitalAnalysis,
			observedUrls: ["https://swisscapitalloans.sc-sec.online/"],
			reporter: { name: "Phishing Support", organization: "Phishing Support", website: "https://phishing.support", email: "support@phishing.support" },
			observedAt: new Date("2026-08-30T10:34:09Z"),
			analysisFacts: facts,
		});
		expect(payload.prompt).toContain('"impersonatedBrand":"Swiss Capital Corp"');
		expect(payload.prompt).toContain('"brandOfficialWebsite":"https://swisscapitalcorp.com/"');
		expect(payload.prompt).toContain("brandOfficialWebsite for brand, trademark, or official-website fields");
	});

	test("never present the reported site or a private URL as the brand's official website", async () => {
		for (const brandOfficialWebsite of ["https://login.swisscapitalloans.sc-sec.online/", "http://10.0.0.1/", "not a url"]) {
			const facts = await deriveProviderFormFacts({ target: "swisscapitalloans.sc-sec.online", analysis: "x" }, async () => ({ ...extracted, brandOfficialWebsite }));
			expect(facts.brandOfficialWebsite).toBeUndefined();
			expect(facts.impersonatedBrand).toBe("Swiss Capital Corp");
		}
		// A lookalike that only ends with the target's text is a different site.
		const lookalike = await deriveProviderFormFacts({ target: "bank.com", analysis: "x" }, async () => ({ ...extracted, brandOfficialWebsite: "https://examplebank.com/" }));
		expect(lookalike.brandOfficialWebsite).toBe("https://examplebank.com/");
	});

	test("prefer an operator-supplied brand URL and survive a failing or malformed model", async () => {
		const supplied = await deriveProviderFormFacts({ target: "x.example", analysis: "x", legalBrandUrl: "https://www.tiktok.com/coin" }, async () => extracted);
		expect(supplied.brandOfficialWebsite).toBe("https://www.tiktok.com/coin");
		expect(await deriveProviderFormFacts({ target: "x.example", analysis: "x" }, async () => { throw new Error("gateway down"); })).toEqual({});
		expect(await deriveProviderFormFacts({ target: "x.example", analysis: "x" }, async () => ({ brand: "unexpected" }))).toEqual({});
	});
});
