import { describe, expect, test } from "bun:test";

import { shouldBlockCloudflareAsset } from "./turnstile";

function request(resourceType: string, url: string) {
	return { resourceType: () => resourceType, url: () => url };
}

describe("Cloudflare abuse form resource filtering", () => {
	test.each([
		["font", "https://abuse.cloudflare.com/fonts/site.woff2"],
		["image", "https://abuse.cloudflare.com/logo.svg"],
		["media", "https://abuse.cloudflare.com/video.mp4"],
		["other", "https://abuse.cloudflare.com/favicon.ico"],
		["other", "https://abuse.cloudflare.com/favicon?version=1"],
	])("blocks unnecessary %s resource %s", (resourceType, url) => {
		expect(shouldBlockCloudflareAsset(request(resourceType, url))).toBeTrue();
	});

	test("keeps scripts and the Turnstile challenge reachable", () => {
		expect(shouldBlockCloudflareAsset(request("script", "https://challenges.cloudflare.com/turnstile/v0/api.js"))).toBeFalse();
		expect(shouldBlockCloudflareAsset(request("document", "https://abuse.cloudflare.com/phishing"))).toBeFalse();
	});
});
