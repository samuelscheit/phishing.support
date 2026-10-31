import { describe, expect, test } from "bun:test";

import { certificateCovers, findOriginServers, MAX_SWEEP_ADDRESSES, originSweepAddresses, planOriginSweep, type PresentedCertificate } from "./sweep";

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
		expect(originSweepAddresses(plan, 0, 10)).toEqual(["8.8.8.8", "9.9.9.0", "9.9.9.1", "9.9.9.2"]);
		expect(plan.addressCount).toBe(4);
		expect(plan.selectedPrefixes).toEqual([
			{ asn: 64501, prefix: "8.8.8.8/32" },
			{ asn: 64500, prefix: "9.9.9.0/24" },
		]);
		expect(plan.totalAddresses).toBe(257);
		expect(plan.truncated).toBe(true);
	});

	test("a nested prefix is swept once and attributed to the smaller allocation", () => {
		const plan = planOriginSweep([
			{ asn: 64500, prefix: "9.9.8.0/23" },
			{ asn: 64501, prefix: "9.9.9.0/24" },
		]);
		expect(plan.addressCount).toBe(512);
		expect(plan.totalAddresses).toBe(512);
		expect(plan.truncated).toBe(false);
		expect(plan.ranges.map(({ asn, start, end }) => ({ asn, size: end - start + 1 }))).toEqual([
			{ asn: 64501, size: 256 },
			{ asn: 64500, size: 256 },
		]);
		expect(new Set(originSweepAddresses(plan, 0, 1_000)).size).toBe(512);
	});

	test("skips non-public space inside an announced prefix", () => {
		// 192.0.0.0/24 and 192.0.2.0/24 are reserved; 192.168.0.0/16 is private.
		const plan = planOriginSweep([
			{ asn: 64500, prefix: "192.0.0.0/22" },
			{ asn: 64501, prefix: "192.168.0.0/15" },
		]);
		const addresses = new Set(originSweepAddresses(plan, 0, plan.addressCount));
		expect(plan.addressCount).toBe(512 + 65_536);
		expect(plan.totalAddresses).toBe(plan.addressCount);
		expect(addresses.size).toBe(plan.addressCount);
		for (const blocked of ["192.0.0.1", "192.0.2.5", "192.168.0.0", "192.168.255.255"]) expect(addresses.has(blocked)).toBe(false);
		for (const allowed of ["192.0.1.0", "192.0.3.255", "192.169.0.0", "192.169.255.255"]) expect(addresses.has(allowed)).toBe(true);
		expect(planOriginSweep([{ asn: 1, prefix: "1.0.0.0/8" }]).addressCount).toBe(MAX_SWEEP_ADDRESSES);
	});

	test("ignores IPv6, malformed, and entirely non-public ranges", () => {
		const plan = planOriginSweep([
			{ asn: 1, prefix: "2001:4860::/32" },
			{ asn: 2, prefix: "10.0.0.0/8" },
			{ asn: 3, prefix: "not-a-prefix" },
		]);
		expect(plan).toEqual({ ranges: [], addressCount: 0, selectedPrefixes: [], totalAddresses: 0, truncated: false });
	});

	test("caps at four million addresses without materializing them, and slices resume exactly", () => {
		const prefixes = ["20.0.0.0/10", "30.0.0.0/10"].map((prefix, index) => ({ asn: 64500 + index, prefix }));
		const plan = planOriginSweep(prefixes);
		expect(plan.totalAddresses).toBe(2 * 4_194_304);
		expect(plan.addressCount).toBe(4_000_000);
		expect(plan.truncated).toBe(true);
		expect(plan.ranges).toHaveLength(1);

		const first = originSweepAddresses(plan, 0, 3);
		const tail = originSweepAddresses(plan, 3_999_998, 10);
		expect(first).toEqual(["20.0.0.0", "20.0.0.1", "20.0.0.2"]);
		// 3,999,999 = 0x3D08FF, the last address before the cap.
		expect(tail).toEqual(["20.61.8.254", "20.61.8.255"]);
		expect(originSweepAddresses(plan, 4_000_000, 10)).toEqual([]);
	});

	test("slices across range boundaries without gaps or overlap", () => {
		const plan = planOriginSweep([
			{ asn: 64500, prefix: "8.8.8.0/30" },
			{ asn: 64501, prefix: "9.9.9.0/29" },
		]);
		const all = originSweepAddresses(plan, 0, 100);
		const sliced = [0, 3, 6, 9].flatMap((offset) => originSweepAddresses(plan, offset, 3));
		expect(sliced).toEqual(all);
		expect(all).toHaveLength(12);
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
