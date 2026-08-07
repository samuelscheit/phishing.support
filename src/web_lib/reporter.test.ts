import { describe, expect, test } from "bun:test";
import {
	countryFlag,
	countryName,
	getReporterHeader,
	getReporterUserAgent,
	normalizeCountryCode,
	readableUserAgent,
} from "./reporter";

describe("reporter metadata formatting", () => {
	test("reads headers case-insensitively, including array values", () => {
		const headers = { "User-Agent": ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X)"] };

		expect(getReporterHeader(headers, "user-agent")).toContain("iPhone");
		expect(getReporterUserAgent(headers)).toContain("iPhone");
		expect(readableUserAgent(headers)).toBe("iPhone");
	});

	test("prefers the client-hint model when available", () => {
		expect(
			readableUserAgent({
				"user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X)",
				"sec-ch-ua-model": '"iPhone 17"',
			}),
		).toBe("iPhone 17");
	});

	test("keeps an iPhone model token readable when it is embedded in the UA", () => {
		expect(readableUserAgent("Mozilla/5.0 (iPhone17,1; CPU iPhone OS 18_5 like Mac OS X) Safari/605.1.15")).toBe("iPhone 17,1");
	});

	test("does not mistake a model hint for the raw user-agent header", () => {
		expect(getReporterUserAgent({ "sec-ch-ua-model": '"iPhone 17"' })).toBeUndefined();
	});

	test("extracts common Android device models", () => {
		expect(readableUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro Build/UQ1A) AppleWebKit/537.36 Chrome/123")).toBe(
			"Pixel 8 Pro",
		);
	});

	test("falls back to a platform label for desktop user-agents", () => {
		expect(readableUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123")).toBe("Windows PC");
	});

	test("normalizes country codes and generates a flag and full name", () => {
		expect(normalizeCountryCode(" de ")).toBe("DE");
		expect(countryFlag("de")).toBe("🇩🇪");
		expect(countryName("DE")).toBe("Germany");
	});

	test("returns undefined for an invalid country code", () => {
		expect(countryFlag("Germany")).toBeUndefined();
		expect(countryName("Deutschland")).toBeUndefined();
	});
});
