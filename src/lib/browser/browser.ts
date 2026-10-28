import type { Browser } from "rebrowser-puppeteer-core";

import { acquireFabricPuppeteerBrowser, type FabricEgress } from "./fabric";

/**
 * Return a lease-scoped CDP client for a Fabric-owned browser.
 *
 * Browser creation used to be scattered across this application and its Docker
 * image. Keeping one Fabric-only entry point makes the manager the sole owner
 * of Chromium, the persistent profile, the egress namespace, and teardown.
 */
export async function getBrowser(egress: FabricEgress = "phishing"): Promise<Browser> {
	// A clone of the reviewed Fabric profile provides a disposable volume while
	// preserving the manager-owned browser fingerprint. The caller receives the
	// worker's default context, never an app-created incognito context.
	const leased = await acquireFabricPuppeteerBrowser(
		{ operation: "phishing-browser" },
		{ leaseMode: "clone", egress },
	);
	return leased.browser as Browser;
}
