import { describe, expect, test } from "bun:test";
import { shouldBlockCloudflareAsset } from "./solveCloudflareTurnstile";

function request(resourceType: string, url: string) {
	return {
		resourceType: () => resourceType,
		url: () => url,
	};
}

describe("Cloudflare abuse resource filtering", () => {
	test.each([
		["image", "https://abuse.cloudflare.com/logo.svg"],
		["font", "https://abuse.cloudflare.com/font.woff2"],
		["media", "https://abuse.cloudflare.com/video.mp4"],
		["other", "https://abuse.cloudflare.com/favicon.ico"],
	])("blocks unnecessary %s requests", (resourceType, url) => {
		expect(shouldBlockCloudflareAsset(request(resourceType, url))).toBe(true);
	});

	test("keeps Turnstile and form resources available", () => {
		expect(shouldBlockCloudflareAsset(request("document", "https://abuse.cloudflare.com/phishing"))).toBe(false);
		expect(shouldBlockCloudflareAsset(request("script", "https://challenges.cloudflare.com/turnstile/v0/api.js"))).toBe(false);
		expect(shouldBlockCloudflareAsset(request("stylesheet", "https://abuse.cloudflare.com/assets/app.css"))).toBe(false);
		expect(shouldBlockCloudflareAsset(request("xhr", "https://abuse.cloudflare.com/api/v2/form/abuse_phishing"))).toBe(false);
	});

});
