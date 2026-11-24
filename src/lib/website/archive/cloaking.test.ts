import { describe, expect, test } from "bun:test";

import type { FabricEgress } from "../../browser/fabric";
import { archiveWebsite } from "./";
import { archiveBrowserFixture, responseForNavigation } from "./test_fixture";

describe("cloaking", () => {
	const url = "https://lookup-lgr.to/en/verification";
	const decoyUrl = "https://www.wikipedia.org/";
	const kitUrl = "https://device.ledger-config.live/en";

	/** The submitted interstitial loads, then its script navigates to where its server sent this visitor. */
	function cloakerFixture(destination: (egress: FabricEgress) => string | undefined, options: { residentialOnline?: boolean; jumpBeforeLoad?: boolean } = {}) {
		return archiveBrowserFixture({
			pageUrl: url,
			goto: async ({ egress, replaceDocument }) => {
				if (egress === "residential" && options.residentialOnline === false) throw new Error("net::ERR_PROXY_CONNECTION_FAILED");
				const target = destination(egress);
				const submitted = responseForNavigation(url, 200, { contentType: "text/html; charset=utf-8" });
				if (!target) return submitted;
				const jumped = responseForNavigation(target, 200, { contentType: "text/html; charset=utf-8" });
				// A jump from the page's <head> beats DOMContentLoaded: the browser
				// sees the submitted document, and the navigation resolves with the destination.
				if (options.jumpBeforeLoad) {
					replaceDocument(submitted);
					return jumped;
				}
				setTimeout(() => replaceDocument(jumped), 5);
				return submitted;
			},
		});
	}
	const settle = { scriptNavigationSettleMs: 500 } as const;

	test("follows the interstitial's script navigation and records it as its own hop", async () => {
		const fixture = cloakerFixture(() => `${url}/done`);

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		expect(fixture.leasedEgress).toEqual(["residential"]);
		expect(archive.url).toBe(`${url}/done`);
		expect(archive.cloaking).toBeUndefined();
		expect(archive.navigationHops).toEqual([
			{ index: 0, url, hostname: "lookup-lgr.to", status: 200, redirectTo: `${url}/done`, contentType: "text/html; charset=utf-8", contentCaptured: false },
			{ index: 1, url: `${url}/done`, hostname: "lookup-lgr.to", status: 200, contentType: "text/html; charset=utf-8", contentCaptured: true },
		]);
	});

	test("a scripted jump of the residential exit to another site is returned as scripted cloaking, and no other route is tried", async () => {
		const fixture = cloakerFixture((egress) => (egress === "residential" ? kitUrl : decoyUrl));

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		// The residential exit sees what a victim sees; Tor and the server IP are never leased.
		expect(fixture.leasedEgress).toEqual(["residential"]);
		expect(fixture.closeCount).toBe(1);
		expect(archive.url).toBe(kitUrl);
		expect(archive.cloaking).toEqual({
			outcome: "scripted",
			detail: `${url} sent the residential exit to ledger-config.live by script`,
		});
		expect(archive.navigationHops.map(({ url: hopUrl, redirectTo, contentCaptured }) => ({ hopUrl, redirectTo, contentCaptured }))).toEqual([
			{ hopUrl: url, redirectTo: kitUrl, contentCaptured: false },
			{ hopUrl: kitUrl, redirectTo: undefined, contentCaptured: true },
		]);
	});

	test("a capture over one route uses only that route: where it is sent is the page, with no cloaking check", async () => {
		const fixture = cloakerFixture(() => kitUrl);
		const archive = await archiveWebsite({ url, egress: "residential" }, { ...settle, getBrowser: fixture.getBrowser });
		expect(fixture.leasedEgress).toEqual(["residential"]);
		expect(archive).toMatchObject({ url: kitUrl, route: "residential exit", egress: "residential" });
		expect(archive.cloaking).toBeUndefined();
	});

	test("a scripted jump to a decoy site is captured and leaves the verdict to the destination", async () => {
		const fixture = cloakerFixture(() => decoyUrl);

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		// apple-condition.com (submission 376291398434951215): its cloakit check
		// sent the residential exit to Wikipedia.
		expect(fixture.leasedEgress).toEqual(["residential"]);
		expect(fixture.closeCount).toBe(1);
		expect(archive.url).toBe(decoyUrl);
		expect(archive.cloaking).toEqual({
			outcome: "scripted",
			detail: `${url} sent the residential exit to wikipedia.org by script`,
		});
	});

	test("a jump the page's <head> makes before it finishes loading is still the submitted page's scripted jump", async () => {
		// docusign.alt3-doc3ea7-v2.sbs (submission 376813288618463354) answers with
		// `location.replace` to a random news front page in its <head>, so the
		// navigation resolved with the news site and the capture looked like a
		// plain visit to it.
		const rotation: Partial<Record<FabricEgress, string>> = { residential: "https://www.bbc.com/" };
		const fixture = cloakerFixture((egress) => rotation[egress], { jumpBeforeLoad: true });

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		expect(fixture.leasedEgress).toEqual(["residential"]);
		expect(archive.url).toBe("https://www.bbc.com/");
		expect(archive.cloaking).toEqual({
			outcome: "scripted",
			detail: `${url} sent the residential exit to bbc.com by script`,
		});
		expect(archive.navigationHops).toEqual([
			{ index: 0, url, hostname: "lookup-lgr.to", status: 200, redirectTo: "https://www.bbc.com/", contentType: "text/html; charset=utf-8", contentCaptured: false },
			{ index: 1, url: "https://www.bbc.com/", hostname: "www.bbc.com", status: 200, contentType: "text/html; charset=utf-8", contentCaptured: true },
		]);
	});

	test("a jump before load to a decoy site is scripted cloaking of the residential exit", async () => {
		const fixture = cloakerFixture(() => decoyUrl, { jumpBeforeLoad: true });

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		expect(fixture.leasedEgress).toEqual(["residential"]);
		expect(archive.url).toBe(decoyUrl);
		expect(archive.cloaking?.outcome).toBe("scripted");
		expect(archive.navigationHops.map(({ url: hopUrl, redirectTo }) => ({ hopUrl, redirectTo }))).toEqual([
			{ hopUrl: url, redirectTo: decoyUrl },
			{ hopUrl: decoyUrl, redirectTo: undefined },
		]);
	});

	test("a jump before load that stays on the submitted site is recorded as a hop and never counts as cloaking", async () => {
		const fixture = cloakerFixture(() => `${url}/step-2`, { jumpBeforeLoad: true });

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		expect(fixture.leasedEgress).toEqual(["residential"]);
		expect(archive.cloaking).toBeUndefined();
		expect(archive.url).toBe(`${url}/step-2`);
		expect(archive.navigationHops.map(({ url: hopUrl, redirectTo, contentCaptured }) => ({ hopUrl, redirectTo, contentCaptured }))).toEqual([
			{ hopUrl: url, redirectTo: `${url}/step-2`, contentCaptured: false },
			{ hopUrl: `${url}/step-2`, redirectTo: undefined, contentCaptured: true },
		]);
	});

	test("a scripted jump that stays on the submitted site never counts as cloaking", async () => {
		const fixture = cloakerFixture(() => `${url}/step-2`);

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		expect(fixture.leasedEgress).toEqual(["residential"]);
		expect(archive.cloaking).toBeUndefined();
	});

	test("a scripted jump over Tor after the residential exit failed is unresolved cloaking, and the server IP is not tried", async () => {
		const fixture = cloakerFixture(() => decoyUrl, { residentialOnline: false });

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		expect(fixture.leasedEgress).toEqual(["residential", "phishing"]);
		expect(archive.url).toBe(decoyUrl);
		expect(archive.cloaking).toEqual({
			outcome: "unresolved",
			detail: `${url} sent the Tor exit to wikipedia.org by script; net::ERR_PROXY_CONNECTION_FAILED via residential exit`,
		});
	});

	test("a scripted destination that fails is unreachable, never a capture of Chromium's error page", async () => {
		// Production 2026-10-30: the residential exit followed the cloaker to the kit,
		// which redirected to a dead decoy host (HTTP 502). Chromium then showed
		// chrome-error://chromewebdata/, which was captured as if it were a site.
		const deadUrl = "http://ogenhoallin.com/";
		const fixture = archiveBrowserFixture({
			pageUrl: url,
			goto: async ({ egress, replaceDocument }) => {
				if (egress === "residential") {
					setTimeout(() => replaceDocument(Object.assign(
						responseForNavigation(deadUrl, 502, { contentType: "text/html", redirects: [{ url: "https://device.ledger-config.live/", status: 307, location: deadUrl }] }),
						{ url: () => deadUrl },
					)), 5);
					setTimeout(() => replaceDocument(responseForNavigation("chrome-error://chromewebdata/", 200, {})), 15);
				} else {
					setTimeout(() => replaceDocument(responseForNavigation(decoyUrl, 200, { contentType: "text/html" })), 5);
				}
				return responseForNavigation(url, 200, { contentType: "text/html; charset=utf-8" });
			},
		});

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		expect(fixture.leasedEgress).toEqual(["residential", "phishing"]);
		expect(archive.url).toBe(decoyUrl);
		expect(archive.cloaking).toEqual({
			outcome: "unresolved",
			detail: `${url} sent the Tor exit to wikipedia.org by script; the page sent the visitor to https://device.ledger-config.live/, which ended in HTTP 502 at ${deadUrl} via residential exit`,
		});
	});

	test("a scripted jump over the server IP, reached only after residential and Tor failed, is unresolved cloaking naming both failures", async () => {
		const fixture = archiveBrowserFixture({
			pageUrl: url,
			goto: async ({ egress, replaceDocument }) => {
				if (egress === "residential") throw new Error(`net::ERR_CONNECTION_RESET at ${url}`);
				if (egress === "phishing") throw new Error(`net::ERR_TIMED_OUT at ${url}`);
				setTimeout(() => replaceDocument(responseForNavigation(decoyUrl, 200, { contentType: "text/html" })), 5);
				return responseForNavigation(url, 200, { contentType: "text/html" });
			},
		});

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		expect(fixture.leasedEgress).toEqual(["residential", "phishing", "reporting"]);
		expect(archive.url).toBe(decoyUrl);
		expect(archive.cloaking).toEqual({
			outcome: "unresolved",
			detail: `${url} sent the server IP to wikipedia.org by script; net::ERR_CONNECTION_RESET at ${url} via residential exit; net::ERR_TIMED_OUT at ${url} via Tor exit`,
		});
	});

	test("a short link's HTTP redirects to a cloaker do not hide the cloaker's scripted jump", async () => {
		// Production 2026-11-01 (375199039110516736): share.google 302s through
		// google.com to an s-url.sbs bot check, whose script sent the Tor exit to
		// a troll page and real visitors to an Ozon kit.
		const shortUrl = "https://share.google/xnf72t40tx4fzvKM2";
		const googleUrl = "https://www.google.com/share.google?q=xnf72t40tx4fzvKM2";
		const cloakerUrl = "https://s-url.sbs/EoZAxs";
		const trollUrl = "https://fuckyou.gay/";
		const ozonUrl = "https://xj0r2x2j-ozon.agenticive.com/price.php";
		const fixture = archiveBrowserFixture({
			pageUrl: cloakerUrl,
			goto: async ({ egress, replaceDocument }) => {
				setTimeout(() => replaceDocument(responseForNavigation(egress === "residential" ? ozonUrl : trollUrl, 200, { contentType: "text/html" })), 5);
				return responseForNavigation(cloakerUrl, 200, {
					contentType: "text/html; charset=utf-8",
					redirects: [{ url: shortUrl, status: 302, location: googleUrl }, { url: googleUrl, status: 301, location: cloakerUrl }],
				});
			},
		});

		const archive = await archiveWebsite({ url: shortUrl }, { ...settle, getBrowser: fixture.getBrowser });

		expect(fixture.leasedEgress).toEqual(["residential"]);
		expect(archive.url).toBe(ozonUrl);
		expect(archive.cloaking).toEqual({
			outcome: "scripted",
			detail: `${shortUrl} sent the residential exit to agenticive.com by script`,
		});
	});

	test("an HTTP redirect to another site is the host's declared destination and never counts as cloaking", async () => {
		const fixture = archiveBrowserFixture({
			pageUrl: kitUrl,
			goto: async () => responseForNavigation(kitUrl, 200, { contentType: "text/html", redirects: [{ url, status: 302, location: kitUrl }] }),
		});

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		expect(fixture.leasedEgress).toEqual(["residential"]);
		expect(archive.cloaking).toBeUndefined();
	});
});
