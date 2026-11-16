import type { Protocol } from "rebrowser-puppeteer-core";

import { getReporterHeader, getReporterUserAgent } from "../../web_lib/reporter";
import { IPHONE_SCREEN, type BrowserIdentity, type TouchScreen } from "./page";

/**
 * The reporter's own browser, as the capture presents it: the User-Agent,
 * client hints and languages the reporter's browser sent with the report.
 * Kits serve their payload only to the platforms they target and show
 * everyone else a decoy: macmorrow.app (production case 380697679325302795)
 * showed its `curl … | osascript` install command only to a Mac and told
 * the Windows capture "MacMorrow is made for Mac". The reporter saw the page
 * the kit meant for them, so their browser is the one to present.
 *
 * Undefined when the headers name no browser the capture can present:
 * none at all (a report by email or a background job), an automated client,
 * or a Linux desktop, which kits send to a decoy (production case
 * 374589286864916480) and which the capture's own Chromium already is.
 */
export function reporterBrowserIdentity(headers: Record<string, string> | undefined): BrowserIdentity | undefined {
	const userAgent = getReporterUserAgent(headers);
	if (!userAgent || userAgent.length > MAX_USER_AGENT_LENGTH || !/^Mozilla\/5\.0 \([^\x00-\x1f\x7f]+$/.test(userAgent) || AUTOMATED_CLIENT.test(userAgent)) return undefined;
	const device = DEVICES.find((candidate) => candidate.matches.test(userAgent));
	if (!device) return undefined;
	const acceptLanguage = languageList(getReporterHeader(headers, "accept-language"));
	const userAgentMetadata = clientHints(headers, device);
	return {
		override: {
			userAgent,
			platform: device.navigatorPlatform,
			...(acceptLanguage ? { acceptLanguage } : {}),
			...(userAgentMetadata ? { userAgentMetadata } : {}),
		},
		screen: device.screen(userAgent),
	};
}

const MAX_USER_AGENT_LENGTH = 512;
const AUTOMATED_CLIENT = /HeadlessChrome|PhantomJS|Lighthouse|\b(?:bot|crawler|spider)\b/i;

type ReporterDevice = {
	matches: RegExp;
	/** navigator.platform on that device. */
	navigatorPlatform: string;
	/** Sec-CH-UA-Platform, for a browser whose headers omit it. */
	clientHintPlatform: string;
	/** High-entropy hints no request header carries: a current release of the platform. */
	platformVersion: string;
	architecture: string;
	bitness: string;
	screen: (userAgent: string) => "desktop" | TouchScreen;
};

const ANDROID_PHONE: TouchScreen = { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true };
const ANDROID_TABLET: TouchScreen = { width: 800, height: 1280, deviceScaleFactor: 2, mobile: false };
const IPAD_SCREEN: TouchScreen = { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true };

/** In match order: an iPhone's and an Android's User-Agent also name other platforms. */
const DEVICES: readonly ReporterDevice[] = [
	{ matches: /\b(?:iPhone|iPod)\b/, navigatorPlatform: "iPhone", clientHintPlatform: "iOS", platformVersion: "18.6.2", architecture: "", bitness: "", screen: () => IPHONE_SCREEN },
	{ matches: /\biPad\b/, navigatorPlatform: "iPad", clientHintPlatform: "iOS", platformVersion: "18.6.2", architecture: "", bitness: "", screen: () => IPAD_SCREEN },
	{ matches: /\bAndroid\b/, navigatorPlatform: "Linux armv81", clientHintPlatform: "Android", platformVersion: "15.0.0", architecture: "", bitness: "", screen: (userAgent) => (/\bMobile\b/.test(userAgent) ? ANDROID_PHONE : ANDROID_TABLET) },
	{ matches: /\bMacintosh\b/, navigatorPlatform: "MacIntel", clientHintPlatform: "macOS", platformVersion: "15.6.1", architecture: "arm", bitness: "64", screen: () => "desktop" },
	{ matches: /\bWindows NT\b/, navigatorPlatform: "Win32", clientHintPlatform: "Windows", platformVersion: "19.0.0", architecture: "x86", bitness: "64", screen: () => "desktop" },
	{ matches: /\bCrOS\b/, navigatorPlatform: "Linux x86_64", clientHintPlatform: "Chrome OS", platformVersion: "16328.65.0", architecture: "x86", bitness: "64", screen: () => "desktop" },
];

/**
 * The client hints of a Chromium-based reporter (Chrome, Edge, Opera, …):
 * the brands its Sec-CH-UA header listed, verbatim, so the capture names the
 * same browser in navigator.userAgentData and its own Sec-CH-UA. Safari and
 * Firefox send none and present none.
 */
function clientHints(headers: Record<string, string> | undefined, device: ReporterDevice): Protocol.Emulation.UserAgentMetadata | undefined {
	const brands = [...(getReporterHeader(headers, "sec-ch-ua") ?? "").matchAll(/"([^"]{1,64})"\s*;\s*v\s*=\s*"([\d.]{1,32})"/g)].map(([, brand, version]) => ({ brand: brand!, version: version! }));
	if (!brands.length) return undefined;
	const fullVersionList = brands.map(({ brand, version }) => ({ brand, version: fullVersion(version) }));
	const browser = fullVersionList.find(({ brand }) => !/Not.A.Brand/i.test(brand) && brand !== "Chromium") ?? fullVersionList.find(({ brand }) => brand === "Chromium");
	return {
		brands,
		fullVersionList,
		fullVersion: browser?.version ?? "",
		platform: unquoted(getReporterHeader(headers, "sec-ch-ua-platform")) || device.clientHintPlatform,
		platformVersion: device.platformVersion,
		architecture: device.architecture,
		bitness: device.bitness,
		model: unquoted(getReporterHeader(headers, "sec-ch-ua-model")),
		mobile: getReporterHeader(headers, "sec-ch-ua-mobile") === "?1",
		wow64: false,
	};
}

/** A major version as Chrome's full version list spells it: `157` → `157.0.0.0`. */
function fullVersion(version: string): string {
	const parts = version.split(".");
	return [...parts, "0", "0", "0"].slice(0, Math.max(4, parts.length)).join(".");
}

function unquoted(value: string | undefined): string {
	return value?.replace(/^"|"$/g, "").trim() ?? "";
}

/**
 * The reporter's languages as Chrome takes them, a plain comma list that it
 * weighs itself in its Accept-Language header and lists in navigator.languages:
 * `en-US,en;q=0.9,de;q=0.8` → `en-US,en,de`.
 */
function languageList(header: string | undefined): string | undefined {
	const tags = (header ?? "").split(",").map((entry) => entry.split(";")[0]!.trim()).filter((tag) => /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(tag));
	return tags.length ? [...new Set(tags)].slice(0, 10).join(",") : undefined;
}
