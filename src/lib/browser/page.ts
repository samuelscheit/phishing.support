import type { Browser, BrowserContext, CDPSession, Page, Protocol } from "rebrowser-puppeteer-core";

import { sleep } from "../utils";
import type { WebsiteDevice } from "../website_types";
import { getBrowser } from "./browser";

/**
 * A desktop browser as a visitor has it: a 1920×1080 screen, a window below
 * the menu bar, and the page below the window's own tab and address bar.
 * Cloakers compare these: a headless default (an 800×600 screen holding a
 * page larger than its window) is answered with a decoy, and so is a window no
 * taller than the page it shows (production case 375199039110516736).
 */
const DESKTOP_SCREEN = { width: 1920, height: 1080 } as const;
const DESKTOP_WINDOW = { left: 0, top: 25, width: 1920, height: 1050 } as const;
const BROWSER_TOOLBAR_HEIGHT = 87;

/**
 * Chrome's brand list for a major version, as Chrome builds it: a GREASE brand
 * whose characters, version and position follow from the major version, then
 * Chromium and Google Chrome (Chromium's user_agent_utils.cc).
 */
export function chromeBrands(major: number, version: string): Protocol.Emulation.UserAgentBrandVersion[] {
	const greaseChars = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
	const grease = { brand: `Not${greaseChars[major % greaseChars.length]}A${greaseChars[(major + 1) % greaseChars.length]}Brand`, version: ["8", "99", "24"][major % 3]! };
	const brands = [grease, { brand: "Chromium", version }, { brand: "Google Chrome", version }];
	const order = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]][major % 6]!;
	const shuffled: Protocol.Emulation.UserAgentBrandVersion[] = [];
	order.forEach((position, index) => { shuffled[position] = brands[index]!; });
	return shuffled;
}

/**
 * The browser's own Chrome build, presented as Google Chrome on 64-bit
 * Windows: the User-Agent header, navigator.userAgent/platform and the client
 * hints all say so. Fabric's browsers are Chromium on Linux, and kits send
 * Linux desktops, which few real victims use, to a dead decoy host
 * (device.ledger-access.live → ogenhoallin.com for production case 374589286864916480).
 */
export function windowsDesktopIdentity(product: string): Protocol.Emulation.SetUserAgentOverrideRequest {
	const fullVersion = /^(?:Headless)?Chrome\/(\d+)\.[\d.]+$/.exec(product) ? product.slice(product.indexOf("/") + 1) : undefined;
	if (!fullVersion) throw new Error(`The browser reports no Chrome version: ${product}`);
	const major = fullVersion.split(".")[0]!;
	return {
		userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
		platform: "Win32",
		userAgentMetadata: {
			brands: chromeBrands(Number(major), major),
			fullVersionList: chromeBrands(Number(major), fullVersion),
			fullVersion,
			platform: "Windows",
			platformVersion: "19.0.0",
			architecture: "x86",
			bitness: "64",
			model: "",
			mobile: false,
			wow64: false,
		},
	};
}

/** A touch device's screen, which its page fills. */
export type TouchScreen = { width: number; height: number; deviceScaleFactor: number; mobile: boolean };

/**
 * Who the browser claims to be: its User-Agent, navigator.platform, client
 * hints and languages, on a desktop window or a touch screen. A browser
 * without `userAgentMetadata` (Safari, Firefox) exposes no client hints.
 */
export type BrowserIdentity = {
	override: Protocol.Emulation.SetUserAgentOverrideRequest;
	screen: "desktop" | TouchScreen;
};

/** Safari and Firefox expose no User-Agent client hints; Chromium's would give the Linux build away. */
const NO_CLIENT_HINTS = "delete Navigator.prototype.userAgentData;";

/**
 * Present an identity to the page. Puppeteer applies it to the page and to
 * every worker and out-of-process frame it attaches later, but through the
 * Network domain, whose platform Chrome ignores: navigator.platform stayed
 * "Linux x86_64". The same identity through the Emulation domain on the
 * page's session sets it. Dedicated workers keep their own
 * navigator.platform, which neither domain reaches. The overrides live as
 * long as the CDP session that set them, so the session stays attached.
 */
async function presentIdentity(page: Page, identity: BrowserIdentity): Promise<string> {
	const cdp = await page.createCDPSession();
	const { userAgent, userAgentMetadata, platform } = identity.override;
	await page.setUserAgent({ userAgent, userAgentMetadata, platform });
	await cdp.send("Emulation.setUserAgentOverride", identity.override);
	// On the page's own session: a script added through the side session never runs.
	if (!userAgentMetadata) await page.evaluateOnNewDocument(NO_CLIENT_HINTS);
	await (identity.screen === "desktop" ? useDesktopWindow(cdp) : useTouchScreen(cdp, identity.screen));
	return userAgent;
}

async function useDesktopWindow(cdp: CDPSession): Promise<void> {
	const { windowId } = await cdp.send("Browser.getWindowForTarget");
	await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal", ...DESKTOP_WINDOW } });
	await cdp.send("Emulation.setDeviceMetricsOverride", {
		width: DESKTOP_WINDOW.width,
		height: DESKTOP_WINDOW.height - BROWSER_TOOLBAR_HEIGHT,
		deviceScaleFactor: 1,
		mobile: false,
		screenWidth: DESKTOP_SCREEN.width,
		screenHeight: DESKTOP_SCREEN.height,
	});
}

async function useTouchScreen(cdp: CDPSession, screen: TouchScreen): Promise<void> {
	await cdp.send("Emulation.setDeviceMetricsOverride", { ...screen, screenWidth: screen.width, screenHeight: screen.height });
	await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
}

/**
 * Safari on an iPhone 15 with iOS 18.6.2. Mobile-only kits turn desktops
 * away with a QR code and serve their exploit loader only to iPhones of the
 * versions it targets (production case 377486973465530391 gates on
 * 18.5–18.6.2 and below 18); a current iOS is served nothing. The exploit
 * code is built for Apple's WebKit and only runs to its first failure in
 * Chromium, which is how the capture sees the stages it loads.
 */
export const IPHONE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
export const IPHONE_SCREEN: TouchScreen = { width: 393, height: 852, deviceScaleFactor: 3, mobile: true };
const IPHONE_IDENTITY: BrowserIdentity = { override: { userAgent: IPHONE_USER_AGENT, platform: "iPhone" }, screen: IPHONE_SCREEN };

/**
 * Set up a page attached to a Fabric-owned browser lease. A desktop capture
 * presents the reporter's own browser when it is known (`visitor`), since
 * kits serve their payload only to the platforms they target, and otherwise
 * Google Chrome on Windows; a phone handoff presents the iPhone.
 */
export async function getBrowserPage(existingPage?: Page, device: WebsiteDevice = "desktop", visitor?: BrowserIdentity) {
	const browser = (existingPage ? existingPage.browser() : await getBrowser()) as Browser;
	const context = (existingPage ? existingPage.browserContext() : browser.defaultBrowserContext()) as BrowserContext;
	const page = existingPage || (await context.newPage());

	page.on("console", (message) => {
		console.log(`[Browser Console] [${message.type()}] ${message.text()}`);
	});

	page.on("dialog", async (dialog) => {
		await sleep(1000 * Math.random() + 1000);
		await dialog.dismiss();
	});
	/** The User-Agent every request of the page sends. */
	const identity = device === "iphone" ? IPHONE_IDENTITY : visitor ?? { override: windowsDesktopIdentity(await browser.version()), screen: "desktop" as const };
	const userAgent = await presentIdentity(page, identity);

	return { page, context, browser, userAgent };
}
