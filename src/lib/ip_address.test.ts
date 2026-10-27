import { expect, test } from "bun:test";

import { isPrivateIpAddress } from "./ip_address";

test("isPrivateIpAddress rejects private, special-use, and malformed addresses", () => {
	for (const address of [
		"0.0.0.0",
		"10.1.2.3",
		"100.64.0.1",
		"127.0.0.1",
		"169.254.1.1",
		"192.168.1.1",
		"198.51.100.42",
		"::1",
		"fc00::1",
		"fe80::1",
		"not-an-ip",
	]) {
		expect(isPrivateIpAddress(address)).toBeTrue();
	}
});

test("isPrivateIpAddress accepts public IPv4, IPv6, and IPv4-mapped IPv6 addresses", () => {
	for (const address of ["8.8.8.8", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
		expect(isPrivateIpAddress(address)).toBeFalse();
	}
});
