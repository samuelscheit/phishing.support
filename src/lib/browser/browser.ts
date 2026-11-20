import type { Browser } from "rebrowser-puppeteer-core";

import { acquireFabricPuppeteerBrowser, fabricRelayEndpoint, type FabricEgress } from "./fabric";

/** The relay address of each leased browser, where the visiting agent attaches beside the capture. */
const agentAddresses = new WeakMap<Browser, string>();

/** The relay address the visiting agent connects to; a browser the app did not lease has none. */
export function agentAddressOf(browser: Browser): string | undefined {
	return agentAddresses.get(browser);
}

/**
 * Return a lease-scoped CDP client for a Fabric-owned browser.
 *
 * The one Fabric-only entry point makes the manager the sole owner of
 * Chromium, the persistent profile, the egress namespace, and teardown.
 */
export async function getBrowser(egress: FabricEgress = "phishing"): Promise<Browser> {
	// A clone of the reviewed Fabric profile provides a disposable volume while
	// preserving the manager-owned browser fingerprint. The caller receives the
	// worker's default context, never an app-created incognito context.
	// Two connections: the capture's own, and the visiting agent's beside it.
	const leased = await acquireFabricPuppeteerBrowser(
		{ operation: "phishing-browser" },
		{ leaseMode: "clone", egress, maxExternalConnections: 2 },
	);
	const browser = leased.browser as Browser;
	agentAddresses.set(browser, fabricRelayEndpoint(leased.sessionId));
	return browser;
}
