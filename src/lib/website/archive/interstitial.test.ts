import { expect, test } from "bun:test";

import { shownChallenge, type PageState } from "./interstitial";

const state = (overrides: Partial<PageState>): PageState => ({ captchaState: null, title: "Just a moment...", text: "", html: "", fields: false, vendors: [], bypass: false, ...overrides });

test("a challenge is shown by a vendor's own interstitial or the solver at work, never by a title or a solved, filled-in or warning page", () => {
	expect(shownChallenge(state({ vendors: ["Cloudflare"] }))).toBe("Cloudflare");
	expect(shownChallenge(state({ captchaState: "solving" }))).toBe("captcha");
	expect(shownChallenge(state({ captchaState: "solving", vendors: ["DataDome"], fields: true }))).toBe("DataDome");
	// The title alone: a kit's fake gate copies it.
	expect(shownChallenge(state({}))).toBeUndefined();
	// The solver passed it: whatever is left is the page.
	expect(shownChallenge(state({ captchaState: "solved", vendors: ["Cloudflare"] }))).toBeUndefined();
	// A page a visitor fills in is the site, a captcha widget on it or not.
	expect(shownChallenge(state({ vendors: ["Cloudflare"], fields: true }))).toBeUndefined();
	// Cloudflare's phishing warning had its wait.
	expect(shownChallenge(state({ vendors: ["Cloudflare"], bypass: true }))).toBeUndefined();
	expect(shownChallenge(undefined)).toBeUndefined();
});