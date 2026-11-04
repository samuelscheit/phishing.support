import { expect, test } from "bun:test";
import type { Browser, BrowserContext, Page } from "rebrowser-puppeteer-core";

import { chromeBrands, getBrowserPage, windowsDesktopIdentity } from "./page";

function fakePage() {
	const goto = async () => null;
	const context = {} as BrowserContext;
	const browser = { defaultBrowserContext: () => context, version: async () => "Chrome/156.0.8078.73" } as unknown as Browser;
	const userAgents: unknown[] = [];
	const handlers = new Map<string, (...args: unknown[]) => void>();
	const cdpCalls: Array<{ method: string; params: unknown }> = [];
	let detached = false;
	const page = {
		browser: () => browser,
		browserContext: () => context,
		createCDPSession: async () => ({
			send: async (method: string, params: unknown) => {
				cdpCalls.push({ method, params });
				return method === "Browser.getWindowForTarget" ? { windowId: 7 } : {};
			},
			detach: async () => { detached = true; },
		}),
		setUserAgent: async (options: unknown) => { userAgents.push(options); },
		on: (event: string, listener: (...args: unknown[]) => void) => { handlers.set(event, listener); },
		goto,
	} as unknown as Page;
	return { page, goto, handlers, cdpCalls, userAgents, isDetached: () => detached };
}

test("getBrowserPage leaves Puppeteer's native navigation lifecycle untouched", async () => {
	const { page, goto, handlers } = fakePage();

	const result = await getBrowserPage(page);

	expect(result.page).toBe(page);
	expect(result.page.goto).toBe(goto);
	expect([...handlers.keys()].sort()).toEqual(["console", "dialog"]);
});

test("the page sits in a desktop-sized window on a desktop-sized screen, as cloakers expect", async () => {
	// Production 2026-11-01: s-url.sbs answered the headless 800×600 screen with
	// "outerW<innerW", and a window no taller than its page with "headless-pattern".
	const { page, cdpCalls, isDetached } = fakePage();

	await getBrowserPage(page);

	expect(cdpCalls.slice(1)).toEqual([
		{ method: "Browser.getWindowForTarget", params: undefined },
		{ method: "Browser.setWindowBounds", params: { windowId: 7, bounds: { windowState: "normal", left: 0, top: 25, width: 1920, height: 1050 } } },
		{ method: "Emulation.setDeviceMetricsOverride", params: { width: 1920, height: 963, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 } },
	]);
	// Detaching would drop the override.
	expect(isDetached()).toBe(false);
});

test("the page presents the browser's own Chrome build as Google Chrome on Windows, workers included", async () => {
	// Production 2026-11-04: device.ledger-access.live sent the Linux desktop
	// Fabric reports to a dead decoy host and served Mac, Windows and phones the kit.
	const { page, userAgents, cdpCalls } = fakePage();

	await getBrowserPage(page);

	// Puppeteer's setUserAgent also covers workers and cross-site frames; its
	// Network-domain platform is ignored, so the page's own session sets that.
	const identity = windowsDesktopIdentity("Chrome/156.0.8078.73");
	expect(userAgents).toEqual([{ userAgent: identity.userAgent, userAgentMetadata: identity.userAgentMetadata, platform: identity.platform }]);
	expect(cdpCalls[0]).toEqual({ method: "Emulation.setUserAgentOverride", params: identity });
});

test("the Windows identity keeps the browser's Chrome version in every place a site can read it", () => {
	expect(windowsDesktopIdentity("Chrome/156.0.8078.73")).toEqual({
		userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
		platform: "Win32",
		userAgentMetadata: {
			// The Sec-CH-UA header Google Chrome 156 on macOS sent with submission 376291398434951215.
			brands: [{ brand: "Not:A-Brand", version: "8" }, { brand: "Chromium", version: "156" }, { brand: "Google Chrome", version: "156" }],
			fullVersionList: [{ brand: "Not:A-Brand", version: "8" }, { brand: "Chromium", version: "156.0.8078.73" }, { brand: "Google Chrome", version: "156.0.8078.73" }],
			fullVersion: "156.0.8078.73",
			platform: "Windows",
			platformVersion: "19.0.0",
			architecture: "x86",
			bitness: "64",
			model: "",
			mobile: false,
			wow64: false,
		},
	});
	expect(windowsDesktopIdentity("HeadlessChrome/141.0.7390.54").userAgent).toBe("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36");
	// A browser that is not Chrome must fail loudly rather than claim a made-up version.
	expect(() => windowsDesktopIdentity("Firefox/140.0")).toThrow("The browser reports no Chrome version: Firefox/140.0");
	expect(() => windowsDesktopIdentity("Chrome/")).toThrow("no Chrome version");
});

test("Chrome's brand list matches what real Chrome releases send, including its rotating order", () => {
	const header = (major: number) => chromeBrands(major, String(major)).map(({ brand, version }) => `"${brand}";v="${version}"`).join(", ");
	expect(header(120)).toBe('"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"');
	expect(header(124)).toBe('"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"');
	expect(header(131)).toBe('"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"');
	expect(header(156)).toBe('"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"');
});
