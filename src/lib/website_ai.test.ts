import { test, expect } from "bun:test";

import { buildWebsiteClassificationInput, buildWebsiteEvidence } from "./website_ai";

test("buildWebsiteEvidence preserves captured phishing archive content even when analysis is empty", () => {
	const evidence = buildWebsiteEvidence({
		url: "https://idcredian.com/TylerBaker7651",
		whois: {
			rdap: {
				domain: "IDCREDIAN.COM",
				registrar: { abuse: { email: "support@namebright.com" } },
			},
			dns: { A: ["154.201.78.208"] },
		},
		archive: {
			url: "https://idcredian.com/TylerBaker7651",
			hostname: "idcredian.com",
			text: Buffer.from("Welcome | USPS\nConfirm your delivery address and pay a redelivery fee.", "utf-8"),
			html: Buffer.from('<title>Welcome | USPS</title><form><input name="cardNumber"></form>', "utf-8"),
		},
		analysisText: "",
	});

	expect(evidence).toContain("idcredian.com");
	expect(evidence).toContain("Welcome | USPS");
	expect(evidence).toContain("cardNumber");
	expect(evidence).toContain("154.201.78.208");
	expect(evidence).not.toContain("analysis:");
});

test("buildWebsiteEvidence includes prior analysis only as additional evidence", () => {
	const evidence = buildWebsiteEvidence({
		url: "https://example.test/path",
		whois: {},
		archive: {
			url: "https://example.test/path",
			hostname: "example.test",
			text: Buffer.from("Captured page text", "utf-8"),
			html: Buffer.from("<html>Captured HTML</html>", "utf-8"),
		},
		analysisText: "This resembles a delivery scam.",
	});

	expect(evidence).toContain("Captured page text");
	expect(evidence).toContain("This resembles a delivery scam.");
});

test("buildWebsiteClassificationInput classifies captured evidence instead of empty analysis", () => {
	const input = buildWebsiteClassificationInput({
		url: "https://idcredian.com/TylerBaker7651",
		whois: { dns: { A: ["154.201.78.208"] } },
		archive: {
			url: "https://idcredian.com/TylerBaker7651",
			hostname: "idcredian.com",
			text: Buffer.from("Welcome | USPS\nPayment required for delivery.", "utf-8"),
			html: Buffer.from('<form action="/submit"><input name="cardNumber"></form>', "utf-8"),
			screenshotPng: Buffer.from("fake png bytes", "utf-8"),
		},
		analysisText: "",
	});

	expect(input[0].role).toBe("system");
	expect(input[0].content).toContain("captured archive/screenshot evidence");
	expect(input[1].role).toBe("user");
	expect(Array.isArray(input[1].content)).toBe(true);

	const content = input[1].content as Array<{ type: string; text?: string; image_url?: string }>;
	expect(content[0].type).toBe("input_text");
	expect(content[0].text).toContain("Welcome | USPS");
	expect(content[0].text).toContain("cardNumber");
	expect(content[1].type).toBe("input_image");
	expect(content[1].image_url).toStartWith("data:image/png;base64,");
});
