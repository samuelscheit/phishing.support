import { describe, expect, test } from "bun:test";

import { parseProviderProxy, withIproyalStickySession } from "./proxy";

describe("parseProviderProxy", () => {
	test("splits encoded proxy credentials from the browser server", () => {
		expect(parseProviderProxy("http://reporter:pa%40ss@example.test:8080")).toEqual({
			url: "http://reporter:pa%40ss@example.test:8080",
			browser: {
				server: "http://example.test:8080",
				username: "reporter",
				password: "pa@ss",
			},
			captchaType: "HTTP",
		});
	});

	test("normalizes socks5h for Chromium and the CAPTCHA provider", () => {
		const proxy = parseProviderProxy("socks5h://user:password@[2001:db8::1]:9150");

		expect(proxy.url).toBe("socks5://user:password@[2001:db8::1]:9150");
		expect(proxy.browser).toEqual({
			server: "socks5://[2001:db8::1]:9150",
			username: "user",
			password: "password",
		});
		expect(proxy.captchaType).toBe("SOCKS5");
	});

	test("rejects an unqualified proxy address", () => {
		expect(() => parseProviderProxy("109.199.115.133:9150")).toThrow(
			"PROXY_URL must be a valid HTTP, HTTPS, SOCKS4, or SOCKS5 proxy URL.",
		);
	});

	test("pins IPRoyal rotating traffic to one per-operation session", () => {
		const proxy = parseProviderProxy("http://reporter:pa%40ss@geo.iproyal.com:12321");
		const sticky = withIproyalStickySession(proxy, "cloudflare-test");

		expect(sticky.url).toBe("http://reporter:pa%40ss_session-cloudflare-test@geo.iproyal.com:12321/");
		expect(sticky.browser).toEqual({
			server: "http://geo.iproyal.com:12321",
			username: "reporter",
			password: "pa@ss_session-cloudflare-test",
		});
	});

	test("leaves non-IPRoyal proxy credentials untouched", () => {
		const proxy = parseProviderProxy("http://reporter:password@example.test:8080");
		expect(withIproyalStickySession(proxy, "cloudflare-test")).toEqual(proxy);
	});
});
