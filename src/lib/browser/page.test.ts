import { expect, test } from "bun:test";
import type { Browser, BrowserContext, Page } from "rebrowser-puppeteer-core";

import { chromeBrands, getBrowserPage, IPHONE_SCREEN, IPHONE_USER_AGENT, windowsDesktopIdentity } from "./page";
import { reporterBrowserIdentity } from "./reporter_identity";

function fakePage() {
	const goto = async () => null;
	const context = {} as BrowserContext;
	const browser = { defaultBrowserContext: () => context, version: async () => "Chrome/156.0.8078.73" } as unknown as Browser;
	const userAgents: unknown[] = [];
	const handlers = new Map<string, (...args: unknown[]) => void>();
	const cdpCalls: Array<{ method: string; params: unknown }> = [];
	const documentScripts: string[] = [];
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
		evaluateOnNewDocument: async (script: string) => { documentScripts.push(script); },
		on: (event: string, listener: (...args: unknown[]) => void) => { handlers.set(event, listener); },
		goto,
	} as unknown as Page;
	return { page, goto, handlers, cdpCalls, userAgents, documentScripts, isDetached: () => detached };
}

test("a reporter's browser replaces the Windows default, on the same desktop window", async () => {
	// Production case 380697679325302795: macmorrow.app showed its Terminal command
	// only to a Mac; the Windows capture got "MacMorrow is made for Mac".
	const { page, userAgents, cdpCalls, documentScripts } = fakePage();
	const visitor = reporterBrowserIdentity({
		"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
		"sec-ch-ua": "\"Not-A.Brand\";v=\"99\", \"Google Chrome\";v=\"157\", \"Chromium\";v=\"157\"",
		"accept-language": "de-DE,de;q=0.9",
	})!;

	const { userAgent } = await getBrowserPage(page, "desktop", visitor);

	expect(userAgent).toBe(visitor.override.userAgent);
	expect(userAgents).toEqual([{ userAgent, userAgentMetadata: visitor.override.userAgentMetadata, platform: "MacIntel" }]);
	expect(cdpCalls[0]).toEqual({ method: "Emulation.setUserAgentOverride", params: visitor.override });
	expect(cdpCalls.map(({ method }) => method).slice(1)).toEqual(["Browser.getWindowForTarget", "Browser.setWindowBounds", "Emulation.setDeviceMetricsOverride"]);
	// Chrome keeps its client hints.
	expect(documentScripts).toEqual([]);
});

test("a phone handoff presents the iPhone even when the reporter's browser is known", async () => {
	const { page, cdpCalls, documentScripts } = fakePage();
	const visitor = reporterBrowserIdentity({ "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" })!;

	const { userAgent } = await getBrowserPage(page, "iphone", visitor);

	expect(userAgent).toBe(IPHONE_USER_AGENT);
	expect(cdpCalls).toEqual([
		{ method: "Emulation.setUserAgentOverride", params: { userAgent: IPHONE_USER_AGENT, platform: "iPhone" } },
		{ method: "Emulation.setDeviceMetricsOverride", params: { ...IPHONE_SCREEN, screenWidth: 393, screenHeight: 852 } },
		{ method: "Emulation.setTouchEmulationEnabled", params: { enabled: true, maxTouchPoints: 5 } },
	]);
	// Safari exposes no client hints.
	expect(documentScripts).toEqual(["delete Navigator.prototype.userAgentData;"]);
});

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
