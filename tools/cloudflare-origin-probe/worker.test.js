import { describe, expect, test } from "bun:test";
import { constantTimeEqual, isAuthorized, isIpv4, parseTunnelTarget } from "./core.js";

const env = {
	PROBE_TOKEN: "a".repeat(64),
};

describe("Cloudflare origin probe boundary", () => {
	test("accepts only canonical IPv4 addresses", () => {
		expect(isIpv4("23.27.53.114")).toBe(true);
		expect(isIpv4("192.0.2.999")).toBe(false);
		expect(isIpv4("192.0.2.01")).toBe(false);
		expect(isIpv4("example.com")).toBe(false);
		expect(isIpv4("::1")).toBe(false);
	});

	test("accepts any IPv4 address without an environment allowlist", () => {
		expect(parseTunnelTarget("/v1/tcp/23.27.53.114")).toEqual({ hostname: "23.27.53.114", port: 443 });
		expect(parseTunnelTarget("/v1/tcp/166.88.101.236")).toEqual({ hostname: "166.88.101.236", port: 443 });
		expect(() => parseTunnelTarget("/v1/tcp/example.com")).toThrow("target must be an IPv4 address");
		expect(() => parseTunnelTarget("/v1/tcp/23.27.53.114/extra")).toThrow("target must be an IPv4 address");
	});

	test("does not apply an environment allowlist or range filter", () => {
		expect(parseTunnelTarget("/v1/tcp/10.1.2.3")).toEqual({ hostname: "10.1.2.3", port: 443 });
		expect(parseTunnelTarget("/v1/tcp/169.254.169.254")).toEqual({ hostname: "169.254.169.254", port: 443 });
	});

	test("requires a configured high-entropy token and an exact supplied value", () => {
		const request = (token) => new Request("https://probe.example/v1/tcp/192.0.2.1", { headers: { "x-origin-probe-token": token } });
		expect(isAuthorized(request(env.PROBE_TOKEN), env)).toBe(true);
		expect(isAuthorized(request(`${env.PROBE_TOKEN}x`), env)).toBe(false);
		expect(isAuthorized(request("a".repeat(31)), { ...env, PROBE_TOKEN: "a".repeat(31) })).toBe(false);
		expect(constantTimeEqual("same", "same")).toBe(true);
		expect(constantTimeEqual("same", "different")).toBe(false);
	});
});
