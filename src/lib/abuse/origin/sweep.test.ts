import { describe, expect, test } from "bun:test";

import { certificateCovers, findOriginServers, planOriginSweep, type PresentedCertificate } from "./sweep";

const certificate: PresentedCertificate = {
	names: ["login.example.com"],
	notBefore: "2026-10-01T00:00:00.000Z",
	notAfter: "2027-01-01T00:00:00.000Z",
	issuer: "Example CA",
	fingerprint256: "AA:BB",
};

describe("origin TLS sweep", () => {
	test("matches exact names and one-label wildcards only", () => {
		expect(certificateCovers(["login.example.com"], "LOGIN.EXAMPLE.COM")).toBe(true);
		expect(certificateCovers(["*.example.com"], "login.example.com")).toBe(true);
		expect(certificateCovers(["*.example.com"], "deep.login.example.com")).toBe(false);
		expect(certificateCovers(["*.example.com"], "notexample.com")).toBe(false);
	});

	test("deduplicates overlapping prefixes, prefers complete small ranges, and enforces the cap", () => {
		const plan = planOriginSweep([
			{ asn: 64500, prefix: "9.9.9.0/24" },
			{ asn: 64501, prefix: "8.8.8.8/32" },
			{ asn: 64501, prefix: "8.8.8.8/32" },
		], 4);
		expect(plan.addresses).toEqual(["8.8.8.8", "9.9.9.0", "9.9.9.1", "9.9.9.2"]);
		expect(plan.selectedPrefixes).toEqual([
			{ asn: 64501, prefix: "8.8.8.8/32" },
			{ asn: 64500, prefix: "9.9.9.0/24" },
		]);
		expect(plan.totalAddresses).toBe(257);
		expect(plan.truncated).toBe(true);
	});

	test("ignores IPv6, malformed, and non-public ranges", () => {
		const plan = planOriginSweep([
			{ asn: 1, prefix: "2001:4860::/32" },
			{ asn: 2, prefix: "10.0.0.0/8" },
			{ asn: 3, prefix: "not-a-prefix" },
		]);
		expect(plan).toEqual({ addresses: [], selectedPrefixes: [], totalAddresses: 0, truncated: false });
	});

	test("returns only addresses whose presented certificate covers the requested domain", async () => {
		const calls: string[] = [];
		const found = await findOriginServers({
			domain: "login.example.com",
			addresses: ["8.8.8.8", "9.9.9.9", "1.1.1.1"],
			concurrency: 2,
			probe: async (ip) => {
				calls.push(ip);
				return ip === "9.9.9.9" ? certificate : { ...certificate, names: ["other.example.com"] };
			},
		});
		expect(calls.sort()).toEqual(["1.1.1.1", "8.8.8.8", "9.9.9.9"]);
		expect(found).toEqual([{ ip: "9.9.9.9", certificate }]);
	});
});
