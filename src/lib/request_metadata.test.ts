import { afterEach, describe, expect, test } from "bun:test";
import { getClientIp, getReporterMetadata, normalizeCountryCode } from "./request_metadata";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("request reporter metadata", () => {
	test("uses the trusted Cloudflare client address before forwarded chains", () => {
		const request = new Request("https://phishing.support/api/submissions", {
			headers: {
				"cf-connecting-ip": "203.0.113.7",
				"x-forwarded-for": "198.51.100.9, 192.0.2.4",
				"x-real-ip": "198.51.100.10",
			},
		});

		expect(getClientIp(request)).toBe("203.0.113.7");
	});

	test("parses forwarded IPv4 ports and bracketed IPv6 addresses", () => {
		const withPort = new Request("https://phishing.support", {
			headers: { "x-forwarded-for": "198.51.100.9:443, 192.0.2.4" },
		});
		const withIpv6 = new Request("https://phishing.support", {
			headers: { forwarded: 'for="[2001:db8::9]:443";proto=https' },
		});

		expect(getClientIp(withPort)).toBe("198.51.100.9");
		expect(getClientIp(withIpv6)).toBe("2001:db8::9");
	});

	test("captures all request headers and trusts the Cloudflare country header", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			throw new Error("country lookup should not be needed when CF supplies a country");
		}) as unknown as typeof fetch;

		const request = new Request("https://phishing.support/api/submissions", {
			headers: {
				"cf-connecting-ip": "203.0.113.7",
				"cf-ipcountry": " de ",
				"user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)",
				"x-reporting-client": "web",
			},
		});

		const metadata = await getReporterMetadata(request);

		expect(metadata.reporterIp).toBe("203.0.113.7");
		expect(metadata.reporterCountry).toBe("DE");
		expect(metadata.reporterHeaders).toMatchObject({
			"cf-connecting-ip": "203.0.113.7",
			"cf-ipcountry": "de",
			"user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)",
			"x-reporting-client": "web",
		});
		expect(fetchCalls).toBe(0);
	});

	test("derives country from country.is when no edge country header exists", async () => {
		let requestedUrl: string | undefined;
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
			requestedUrl = String(input);
			return new Response(JSON.stringify({ country: "gb" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const request = new Request("https://phishing.support/api/submissions", {
			headers: {
				"x-forwarded-for": "198.51.100.25, 192.0.2.4",
				"user-agent": "Mozilla/5.0",
			},
		});

		const metadata = await getReporterMetadata(request);

		expect(requestedUrl).toBe("https://api.country.is/198.51.100.25");
		expect(metadata.reporterIp).toBe("198.51.100.25");
		expect(metadata.reporterCountry).toBe("GB");
	});

	test("keeps IP and headers when geolocation fails", async () => {
		globalThis.fetch = (async () => {
			throw new Error("network unavailable");
		}) as unknown as typeof fetch;

		const request = new Request("https://phishing.support/api/submissions", {
			headers: {
				"x-real-ip": "192.0.2.44",
				"user-agent": "Mozilla/5.0",
			},
		});

		const metadata = await getReporterMetadata(request);

		expect(metadata.reporterIp).toBe("192.0.2.44");
		expect(metadata.reporterCountry).toBeUndefined();
		expect(metadata.reporterHeaders).toMatchObject({
			"x-real-ip": "192.0.2.44",
			"user-agent": "Mozilla/5.0",
		});
	});

	test("rejects unknown country sentinels", () => {
		expect(normalizeCountryCode("XX")).toBeUndefined();
		expect(normalizeCountryCode("T1")).toBeUndefined();
		expect(normalizeCountryCode("us")).toBe("US");
	});
});
