import { describe, expect, test } from "bun:test";

import { CLOUDFLARE_TURNSTILE_SITE_KEY, makeCloudflareClearanceCookieUsable, siteKeyFromFrameUrl } from "./turnstile";

describe("Cloudflare Turnstile integration", () => {
	test("extracts the site key from the current challenge-frame URL", () => {
		expect(siteKeyFromFrameUrl(
			`https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/rch/abc/${CLOUDFLARE_TURNSTILE_SITE_KEY}/auto/fbE/new/normal?lang=auto`,
		)).toBe(CLOUDFLARE_TURNSTILE_SITE_KEY);
	});

	test("does not treat arbitrary URL path segments as a Turnstile site key", () => {
		expect(siteKeyFromFrameUrl("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit")).toBeUndefined();
		expect(siteKeyFromFrameUrl("https://example.test/0x123/normal")).toBeUndefined();
	});

	test("keeps the reviewed Cloudflare site key in the expected format", () => {
		expect(CLOUDFLARE_TURNSTILE_SITE_KEY).toMatch(/^0x[A-Za-z0-9_-]+$/);
	});

	test("mirrors a partitioned clearance cookie into the ordinary host jar", async () => {
		const added: unknown[] = [];
		const context = {
			cookies: async () => [{
				name: "cf_clearance",
				value: "clearance-value",
				domain: ".abuse.cloudflare.com",
				path: "/",
				secure: true,
				httpOnly: true,
				sameSite: "None",
				expires: 123,
				partitionKey: "https://cloudflare.com",
			}],
			addCookies: async (cookies: unknown) => { added.push(cookies); },
		} as any;

		await makeCloudflareClearanceCookieUsable(context, "https://abuse.cloudflare.com/phishing");
		expect(added).toEqual([[{
			name: "cf_clearance",
			value: "clearance-value",
			domain: ".abuse.cloudflare.com",
			path: "/",
			secure: true,
			httpOnly: true,
			sameSite: "None",
			expires: 123,
		}]]);
	});
});
