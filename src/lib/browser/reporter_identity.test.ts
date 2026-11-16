import { expect, test } from "bun:test";

import { IPHONE_SCREEN } from "./page";
import { reporterBrowserIdentity } from "./reporter_identity";

/** The headers Google Chrome 157 on macOS sent with production case 380697679325302795 (macmorrow.app). */
const MAC_CHROME = {
	"accept-language": "en-US,en;q=0.9,de-DE;q=0.8,de;q=0.7,ja;q=0.6",
	"sec-ch-ua": "\"Not-A.Brand\";v=\"99\", \"Google Chrome\";v=\"157\", \"Chromium\";v=\"157\"",
	"sec-ch-ua-mobile": "?0",
	"sec-ch-ua-platform": "\"macOS\"",
	"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
};

test("a Mac reporter's Chrome is presented as that Mac: User-Agent, platform, client hints and languages", () => {
	expect(reporterBrowserIdentity(MAC_CHROME)).toEqual({
		override: {
			userAgent: MAC_CHROME["user-agent"],
			// What macmorrow.app's gate reads besides the User-Agent; a Windows platform got the decoy.
			platform: "MacIntel",
			acceptLanguage: "en-US,en,de-DE,de,ja",
			userAgentMetadata: {
				brands: [{ brand: "Not-A.Brand", version: "99" }, { brand: "Google Chrome", version: "157" }, { brand: "Chromium", version: "157" }],
				fullVersionList: [{ brand: "Not-A.Brand", version: "99.0.0.0" }, { brand: "Google Chrome", version: "157.0.0.0" }, { brand: "Chromium", version: "157.0.0.0" }],
				fullVersion: "157.0.0.0",
				platform: "macOS",
				platformVersion: "15.6.1",
				architecture: "arm",
				bitness: "64",
				model: "",
				mobile: false,
				wow64: false,
			},
		},
		screen: "desktop",
	});
});

test("header names are matched case-insensitively and Edge is named by its own brand", () => {
	const identity = reporterBrowserIdentity({
		"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
		"Sec-CH-UA": "\"Chromium\";v=\"140\", \"Not=A?Brand\";v=\"24\", \"Microsoft Edge\";v=\"140\"",
		"Sec-CH-UA-Full-Version": "\"140.0.3485.54\"",
	});
	expect(identity?.override.platform).toBe("Win32");
	expect(identity?.override.userAgentMetadata).toMatchObject({ fullVersion: "140.0.0.0", platform: "Windows", architecture: "x86", mobile: false });
	expect(identity?.override.acceptLanguage).toBeUndefined();
	expect(identity?.screen).toBe("desktop");
});

test("Safari and Firefox present no client hints, as they send none", () => {
	const safari = reporterBrowserIdentity({ "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15", "accept-language": "de-DE,de;q=0.9" });
	expect(safari).toEqual({ override: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15", platform: "MacIntel", acceptLanguage: "de-DE,de" }, screen: "desktop" });
	const firefox = reporterBrowserIdentity({ "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0" });
	expect(firefox?.override).toEqual({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0", platform: "Win32" });
});

test("phones and tablets are presented on their own touch screens", () => {
	const iphone = reporterBrowserIdentity({ "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1" });
	// "like Mac OS X" must not make an iPhone a Mac.
	expect(iphone?.override.platform).toBe("iPhone");
	expect(iphone?.screen).toEqual(IPHONE_SCREEN);

	const pixel = reporterBrowserIdentity({
		"user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36",
		"sec-ch-ua": "\"Google Chrome\";v=\"139\", \"Chromium\";v=\"139\", \"Not;A=Brand\";v=\"99\"",
		"sec-ch-ua-mobile": "?1",
		"sec-ch-ua-platform": "\"Android\"",
		"sec-ch-ua-model": "\"Pixel 9\"",
	});
	// "Linux" in an Android User-Agent must not make it the refused Linux desktop.
	expect(pixel?.override.platform).toBe("Linux armv81");
	expect(pixel?.override.userAgentMetadata).toMatchObject({ platform: "Android", model: "Pixel 9", mobile: true });
	expect(pixel?.screen).toEqual({ width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });

	const tablet = reporterBrowserIdentity({ "user-agent": "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36" });
	expect(tablet?.screen).toMatchObject({ mobile: false });
});

test("no identity without a browser the capture can present: the Windows default stays", () => {
	expect(reporterBrowserIdentity(undefined)).toBeUndefined();
	expect(reporterBrowserIdentity({})).toBeUndefined();
	expect(reporterBrowserIdentity({ "accept-language": "en" })).toBeUndefined();
	// Kits send Linux desktops to decoys; the capture's Chromium is one already.
	expect(reporterBrowserIdentity({ "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36" })).toBeUndefined();
	// Automated and non-browser clients.
	expect(reporterBrowserIdentity({ "user-agent": "curl/8.7.1" })).toBeUndefined();
	expect(reporterBrowserIdentity({ "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/139.0.0.0 Safari/537.36" })).toBeUndefined();
	expect(reporterBrowserIdentity({ "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" })).toBeUndefined();
	// Header injection and oversized values never reach the browser.
	expect(reporterBrowserIdentity({ "user-agent": "Mozilla/5.0 (Windows NT 10.0)\r\nX-Evil: 1" })).toBeUndefined();
	expect(reporterBrowserIdentity({ "user-agent": `Mozilla/5.0 (Windows NT 10.0; ${"x".repeat(600)})` })).toBeUndefined();
});

test("malformed client hints and languages are dropped, not passed on", () => {
	const identity = reporterBrowserIdentity({
		...MAC_CHROME,
		"sec-ch-ua": "garbage",
		"accept-language": "*, <script>, en-GB;q=0.8, en-GB",
	});
	expect(identity?.override.userAgentMetadata).toBeUndefined();
	expect(identity?.override.acceptLanguage).toBe("en-GB");
});
