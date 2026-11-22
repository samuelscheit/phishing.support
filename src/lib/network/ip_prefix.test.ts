import { describe, expect, test } from "bun:test";

import { addressBits, enclosingPrefix, formatAddress, strictlyInside } from "./ip_prefix";

describe("IP prefixes", () => {
	test("an exact CIDR range's enclosing prefix is one bit shorter", () => {
		// APNIC's 14.194.128.0/18 (TATAGSM) sits in 14.194.0.0/15 (TATA-DOCOMO-IN).
		expect(enclosingPrefix("14.194.128.0", "14.194.191.255")).toBe("14.194.128.0/17");
		expect(enclosingPrefix("14.194.0.0", "14.195.255.255")).toBe("14.192.0.0/14");
		expect(enclosingPrefix("10.0.0.0", "10.255.255.255")).toBe("10.0.0.0/7");
	});

	test("a range that is no single CIDR gets the smallest prefix holding it", () => {
		// RIPE's 193.0.0.0 - 193.0.23.255 is a /20 plus a /21.
		expect(enclosingPrefix("193.0.0.0", "193.0.23.255")).toBe("193.0.0.0/19");
		expect(enclosingPrefix("192.0.2.1", "192.0.2.2")).toBe("192.0.2.0/30");
	});

	test("a single address and the whole family", () => {
		expect(enclosingPrefix("192.0.2.7", "192.0.2.7")).toBe("192.0.2.6/31");
		expect(enclosingPrefix("0.0.0.0", "255.255.255.255")).toBeUndefined();
		expect(enclosingPrefix("128.0.0.0", "255.255.255.255")).toBe("0.0.0.0/0");
	});

	test("IPv6 ranges come back compressed", () => {
		expect(enclosingPrefix("2a01:4f8::", "2a01:4f8:ffff:ffff:ffff:ffff:ffff:ffff")).toBe("2a01:4f8::/31");
		expect(enclosingPrefix("2001:db8::", "2001:db8::ff")).toBe("2001:db8::/119");
		expect(enclosingPrefix("::", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBeUndefined();
	});

	test("an invalid range has none", () => {
		expect(enclosingPrefix("192.0.2.9", "192.0.2.1")).toBeUndefined();
		expect(enclosingPrefix("192.0.2.1", "2001:db8::1")).toBeUndefined();
		expect(enclosingPrefix("not-an-ip", "192.0.2.1")).toBeUndefined();
	});

	test("addresses round-trip through their numeric form", () => {
		for (const address of ["0.0.0.0", "14.194.139.244", "255.255.255.255", "::", "2a01:4f8:0:a0a1::2", "2001:db8::ffff:0:1"]) {
			expect(formatAddress(addressBits(address)!)).toBe(address);
		}
		expect(formatAddress(addressBits("::ffff:192.0.2.1")!)).toBe("::ffff:c000:201");
	});

	test("one range lies strictly inside another only when it is smaller and of the same family", () => {
		const allocation = { start: "14.194.128.0", end: "14.194.191.255" };
		expect(strictlyInside(allocation, { start: "14.194.0.0", end: "14.195.255.255" })).toBe(true);
		expect(strictlyInside(allocation, allocation)).toBe(false);
		expect(strictlyInside(allocation, { start: "14.194.130.0", end: "14.195.255.255" })).toBe(false);
		expect(strictlyInside(allocation, { start: "::", end: "ffff::" })).toBe(false);
	});
});
