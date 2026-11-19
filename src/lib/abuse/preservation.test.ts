import { describe, expect, test } from "bun:test";

import { createAbuseEmailDraft } from "./mail/draft";
import { buildProviderReportNarrative } from "./providers/report_payload";
import { PRESERVATION_REQUEST, PRESERVATION_REQUEST_SHORT } from "./preservation";

describe("every takedown report asks the provider to preserve the records", () => {
	test("a mailed report asks for it after the requested action and before the sign-off", async () => {
		const draft = await createAbuseEmailDraft({
			report: { id: 1n, allegationCategory: "phishing", description: "Credential phishing page.", legalBrandUrl: null, submissionId: null, reporterName: null, reporterContactEmail: null },
			target: { normalizedTarget: "phish-kit-test.com", observedUrls: ["https://phish-kit-test.com/login"] },
			route: { createdAt: new Date("2026-11-19T00:00:00Z"), providerDisplayName: "Example Hosting", resolverProvenance: {}, resolutionSnapshot: {} },
			recipient: "abuse@example-hosting.com",
		}, { generateSummary: async () => "The page collects passwords." });
		const action = draft.body.indexOf("Please investigate the relevant domain");
		const preservation = draft.body.indexOf(PRESERVATION_REQUEST);
		expect(action).toBeGreaterThan(0);
		expect(preservation).toBeGreaterThan(action);
		expect(draft.body.indexOf("Regards,")).toBeGreaterThan(preservation);
	});

	test("an operator-approved draft is sent as approved, without additions", async () => {
		const approved = { subject: "Strafanzeige", body: "Sehr geehrte Damen und Herren, …", recipientLabel: "ZCB", allowedUrls: [] };
		const draft = await createAbuseEmailDraft({
			report: { id: 1n, allegationCategory: "phishing", description: "x", legalBrandUrl: null, submissionId: null, reporterName: null, reporterContactEmail: null },
			target: { normalizedTarget: "campaign:1", observedUrls: [] },
			route: { createdAt: new Date("2026-11-19T00:00:00Z"), providerDisplayName: "ZCB", resolverProvenance: {}, resolutionSnapshot: { approvalDraft: approved } },
			recipient: "cybercrime@gensta-ba.bayern.de",
		}, { generateSummary: async () => { throw new Error("must not be asked"); } });
		expect(draft).toEqual({ subject: "Strafanzeige", body: "Sehr geehrte Damen und Herren, …", recipientLabel: "ZCB" });
	});

	test("a provider form gets the short ask when its field has room, and keeps its facts when it has not", () => {
		const input = { provider: "cloudflare" as const, target: "phish-kit-test.com", observedUrls: ["https://phish-kit-test.com/"], description: "Brand: PayPal\nThe page asks for the password." };
		const roomy = buildProviderReportNarrative({ ...input, maximumLength: 2_000 })!;
		expect(roomy.endsWith(PRESERVATION_REQUEST_SHORT)).toBe(true);
		const tight = buildProviderReportNarrative({ ...input, maximumLength: 300 })!;
		expect(tight).not.toContain(PRESERVATION_REQUEST_SHORT);
		expect(tight.length).toBeLessThanOrEqual(300);
		expect(tight).toContain("Please investigate");
	});
});
