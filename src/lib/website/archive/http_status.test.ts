import { describe, expect, test } from "bun:test";

import type { FabricEgress } from "../../browser/fabric";
import { WebsiteCaptureFailedError } from "./errors";
import type { PageState } from "./interstitial";
import { archiveBrowserFixture, fast, firstPage, responseForNavigation } from "./test_fixture";

/**
 * The HTTP status of a page says nothing about what it is: kits serve live
 * pages with 403, 404 or 500, and bot checks answer 200 as readily as 403.
 * A capture keeps every page of the site a route reaches; only a page that
 * turned the network away (a challenge that never passed, a WAF's block, a
 * bare gateway error) sends the capture to the next route.
 */

/** Long enough that a capture waiting on it would fail the test's timing. */
const SLOW_SETTLE_MS = 5_000;
const ALL_ROUTES: FabricEgress[] = ["residential", "phishing", "reporting"];

const hopsOf = (hops: Array<{ index: number; url: string; status: number | null; redirectTo?: string; contentCaptured: boolean; bodyCaptured?: boolean }>) =>
	hops.map(({ index, url, status, redirectTo, contentCaptured, bodyCaptured }) => ({ index, url, status, redirectTo, contentCaptured, bodyCaptured }));
const bodiesOf = (bodies: Array<{ hopIndex: number; body: Buffer }> | undefined) => bodies?.map(({ hopIndex, body }) => ({ hopIndex, body: body.toString("utf8") }));

describe("a page of the site served with an HTTP error status", () => {
	// Production submission 384627246381404160: Next.js hydrated a complete SharePoint lure under HTTP 500.
	const url = "https://survey.centripe.com/survey/6b08319579e39294fe840eb0?preview=true";
	const lure = `<html id="__next_error__"><head><title>Midsona Finland Oy</title></head><body>Uusi asiakirja on jaettu sinulle <a>AVAA</a> Microsoft SharePoint</body></html>`;

	for (const status of [500, 404, 403, 410, 451, 502, 503]) {
		test(`HTTP ${status} is captured from the first route, without waiting or trying another route`, async () => {
			const fixture = archiveBrowserFixture({
				pageUrl: url,
				title: "Midsona Finland Oy",
				documentBodies: { [url]: lure },
				goto: async () => responseForNavigation(url, status, { contentType: "text/html; charset=utf-8" }),
			});
			const started = Date.now();
			const archive = await firstPage({ url }, { ...fast, getBrowser: fixture.getBrowser, interstitialSettleMs: SLOW_SETTLE_MS });

			expect(Date.now() - started).toBeLessThan(SLOW_SETTLE_MS / 2);
			expect(fixture.leasedEgress).toEqual(["residential"]);
			expect(fixture.captureSnapshotCount).toBe(1);
			expect(fixture.screenshotCount).toBe(1);
			expect(archive.url).toBe(url);
			expect(archive.navigationHops).toEqual([
				{ index: 0, url, hostname: "survey.centripe.com", status, contentType: "text/html; charset=utf-8", receivedAt: expect.any(String), bodyCaptured: true, contentCaptured: true },
			]);
			expect(bodiesOf(archive.hopBodies)).toEqual([{ hopIndex: 0, body: lure }]);
			expect(archive.mhtml.toString()).toContain("<title>Midsona Finland Oy</title>");
			expect(archive.screenshotPng).toBeInstanceOf(Buffer);
			expect(archive.providerWarning).toBeUndefined();
			// The page is answered with its own status and body, as it came.
			const fulfilled = fixture.cdpCommands.filter(({ method }) => method === "Fetch.fulfillRequest").map(({ params }) => params as { responseCode: number; body: string });
			expect(fulfilled.map(({ responseCode, body }) => ({ responseCode, body: Buffer.from(body, "base64").toString("utf8") }))).toEqual([{ responseCode: status, body: lure }]);
		});
	}

	test("a login form under 403, and a host's bare 404 page, are the site: captured from the first route", async () => {
		for (const [status, page] of [
			[403, "<html><head><title>Forbidden</title></head><body><h1>Forbidden</h1><form><input name=password type=password></form></body></html>"],
			[404, "<html><head><title>404 Not Found</title></head><body><h1>Not Found</h1><p>The requested URL was not found on this server.</p></body></html>"],
		] as const) {
			const fixture = archiveBrowserFixture({ pageUrl: url, documentBodies: { [url]: page }, goto: async () => responseForNavigation(url, status, { contentType: "text/html" }) });
			const archive = await firstPage({ url }, { ...fast, getBrowser: fixture.getBrowser, interstitialSettleMs: SLOW_SETTLE_MS });
			expect(fixture.leasedEgress).toEqual(["residential"]);
			expect(archive.navigationHops.at(-1)).toMatchObject({ status, contentCaptured: true, bodyCaptured: true });
		}
	});

	test("a page's script that sends the visitor to a destination answering 500 or 404 is followed and the destination captured", async () => {
		for (const status of [500, 404]) {
			const loader = "https://loader.example/";
			const destination = "https://kit.example/login";
			const loaderBody = `<html><body><script>location.href = "${destination}"</script></body></html>`;
			const destinationBody = "<html><body><form><input name=password></form></body></html>";
			const fixture = archiveBrowserFixture({
				pageUrl: loader,
				documentBodies: { [loader]: loaderBody, [destination]: destinationBody },
				goto: async ({ replaceDocument }) => {
					setTimeout(() => replaceDocument(responseForNavigation(destination, status, { contentType: "text/html" })), 5);
					return responseForNavigation(loader, 200, { contentType: "text/html" });
				},
			});

			const archive = await firstPage({ url: loader }, { ...fast, getBrowser: fixture.getBrowser, interstitialSettleMs: SLOW_SETTLE_MS });

			expect(fixture.leasedEgress).toEqual(["residential"]);
			expect(archive.url).toBe(destination);
			expect(hopsOf(archive.navigationHops)).toEqual([
				{ index: 0, url: loader, status: 200, redirectTo: destination, contentCaptured: false, bodyCaptured: true },
				{ index: 1, url: destination, status, redirectTo: undefined, contentCaptured: true, bodyCaptured: true },
			]);
			expect(bodiesOf(archive.hopBodies)).toEqual([{ hopIndex: 0, body: loaderBody }, { hopIndex: 1, body: destinationBody }]);
		}
	});
});

describe("a network turned away", () => {
	const url = "https://xfinityy111.weebly.com/";
	const site = "<html><head><title>Xfinity</title></head><body><form><input name=email><input type=password name=pass></form></body></html>";

	const blockPages: Array<[name: string, status: number, page: string]> = [
		["a bare 403 Forbidden", 403, "<html><head><title>403 Forbidden</title></head><body><h1>403 Forbidden</h1><hr>nginx</body></html>"],
		["Cloudflare's block", 403, "<html><head><title>Attention Required! | Cloudflare</title></head><body><h1>Sorry, you have been blocked</h1><p>You are unable to access weebly.com</p><p>Cloudflare Ray ID: 8f3a2b1c9d0e4f56</p></body></html>"],
		["Akamai's Access Denied, served as 200", 200, "<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1>You don't have permission to access this server. Reference #18.3c2f1402</body></html>"],
		["a bare 502 Bad Gateway", 502, "<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center></body></html>"],
		["Cloudflare's origin error 521", 521, "<html><head><title>weebly.com | 521: Web server is down</title></head><body>Web server is down Error code 521</body></html>"],
	];
	for (const [name, status, page] of blockPages) {
		test(`by ${name} on the residential exit and Tor is retried from the server's direct exit, which gets the site`, async () => {
			// The residential exit and Tor get the block page; the server's direct exit gets the site.
			let route: FabricEgress = "residential";
			const routed = archiveBrowserFixture({
				pageUrl: url,
				documentBodies: { [url]: page },
				goto: async ({ egress }) => {
					route = egress;
					return responseForNavigation(url, egress === "reporting" ? 200 : status, { contentType: "text/html" });
				},
				pageState: () => (route === "reporting" ? { title: "Xfinity", text: "Sign in", html: site, fields: true } : {}),
			});

			const archive = await firstPage({ url }, { ...fast, getBrowser: routed.getBrowser, interstitialSettleMs: SLOW_SETTLE_MS });

			expect(routed.leasedEgress).toEqual(ALL_ROUTES);
			expect(routed.captureSnapshotCount).toBe(1);
			expect(archive.egress).toBe("reporting");
			expect(archive.navigationHops.at(-1)).toMatchObject({ url, status: 200, contentCaptured: true });
		});
	}

	test("on every route fails the capture, naming what each route got", async () => {
		const fixture = archiveBrowserFixture({
			pageUrl: url,
			documentBodies: { [url]: blockPages[1]![2] },
			title: "Attention Required! | Cloudflare",
			goto: async ({ egress }) => responseForNavigation(url, egress === "residential" ? 403 : 200, { contentType: "text/html" }),
		});
		const failure = await firstPage({ url }, { ...fast, getBrowser: fixture.getBrowser, interstitialSettleMs: SLOW_SETTLE_MS }).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(WebsiteCaptureFailedError);
		expect((failure as Error).message).toBe('Failed to load page: HTTP 403 ("Attention Required! | Cloudflare"), a page blocking this network via residential exit; HTTP 200 ("Attention Required! | Cloudflare"), a page blocking this network via Tor exit; HTTP 200 ("Attention Required! | Cloudflare"), a page blocking this network via server IP');
		expect(fixture.leasedEgress).toEqual(ALL_ROUTES);
		expect(fixture.captureSnapshotCount).toBe(0);
		expect(fixture.closeCount).toBe(3);
	});
});

describe("a bot-check interstitial before the site", () => {
	const url = "https://www8-receitafazendagerador.com/Aplicacao/Mei/pgmei.app";
	const realUrl = `${url}/`;
	const challengeBody = "<html><head><title>Just a moment...</title></head><body>Checking</body></html>";
	const realBody = "<html><body>Emitir guia</body></html>";

	const cases: Array<{ name: string; status: number; headers?: Record<string, string>; state?: Partial<PageState> }> = [
		{ name: "Cloudflare's, answering 403", status: 403, state: { vendors: ["Cloudflare"] } },
		{ name: "Cloudflare's, answering 200", status: 200, state: { vendors: ["Cloudflare"] } },
		{ name: "Cloudflare's, localized, answering 503", status: 503, state: { title: "Один момент…", vendors: ["Cloudflare"] } },
		{ name: "named only by Cloudflare's cf-mitigated header, answering 403", status: 403, headers: { "cf-mitigated": "challenge" } },
		{ name: "Vercel's Security Checkpoint, named only by its header, answering 429", status: 429, headers: { "x-vercel-mitigated": "challenge" } },
		{ name: "AWS WAF's, answering 202", status: 202, state: { title: "Human Verification", vendors: ["AWS WAF"] } },
		{ name: "DataDome's, answering 403", status: 403, state: { title: "kit.example", vendors: ["DataDome"] } },
	];
	for (const { name, status, headers, state } of cases) {
		test(`${name}, is waited for until it reloads into the site, captured even under HTTP 500, and its hop dropped`, async () => {
			const fixture = archiveBrowserFixture({
				pageUrl: url,
				title: (current) => (current === url ? "Just a moment..." : "Receita Federal"),
				documentBodies: { [url]: challengeBody, [realUrl]: realBody },
				pageState: (current) => (current === url ? state ?? {} : {}),
				goto: async ({ replaceDocument }) => {
					setTimeout(() => replaceDocument(responseForNavigation(realUrl, 500, {
						contentType: "text/html; charset=UTF-8",
						redirects: [{ url, status: 301, location: realUrl }],
					})), 30);
					return responseForNavigation(url, status, { contentType: "text/html", ...(headers ? { headers } : {}) });
				},
			});

			const archive = await firstPage({ url }, { ...fast, getBrowser: fixture.getBrowser, interstitialSettleMs: SLOW_SETTLE_MS });

			expect(fixture.leasedEgress).toEqual(["residential"]);
			expect(fixture.captureSnapshotCount).toBe(1);
			expect(archive.url).toBe(realUrl);
			expect(hopsOf(archive.navigationHops)).toEqual([
				{ index: 0, url, status: 301, redirectTo: realUrl, contentCaptured: false, bodyCaptured: undefined },
				{ index: 1, url: realUrl, status: 500, redirectTo: undefined, contentCaptured: true, bodyCaptured: true },
			]);
			expect(bodiesOf(archive.hopBodies)).toEqual([{ hopIndex: 1, body: realBody }]);
			expect(archive.mhtml.toString()).toContain("<title>Receita Federal</title>");
		});
	}

	test("replaced under an address with the visitor's fragment still drops the interstitial's hop", async () => {
		const tagged = `${realUrl}#victim@mail.com`;
		const fixture = archiveBrowserFixture({
			pageUrl: url,
			pageState: (current) => (current === url ? { vendors: ["Cloudflare"] } : {}),
			goto: async ({ replaceDocument }) => {
				setTimeout(() => replaceDocument(responseForNavigation(tagged, 200, { contentType: "text/html" })), 30);
				return responseForNavigation(url, 403, { contentType: "text/html" });
			},
		});

		const archive = await firstPage({ url }, { ...fast, getBrowser: fixture.getBrowser, interstitialSettleMs: SLOW_SETTLE_MS });

		expect(archive.navigationHops.map(({ url: hopUrl }) => hopUrl)).toEqual([tagged]);
	});

	test("that nothing replaces sends the capture to the next route once the wait runs out", async () => {
		const fixture = archiveBrowserFixture({
			pageUrl: url,
			documentBodies: { [url]: challengeBody, [realUrl]: realBody },
			pageState: (current) => (current === url ? { vendors: ["Cloudflare"] } : {}),
			goto: async ({ egress }) => (egress === "reporting"
				? responseForNavigation(realUrl, 200, { contentType: "text/html" })
				: responseForNavigation(url, 403, { contentType: "text/html" })),
		});
		const started = Date.now();
		const archive = await firstPage({ url }, { ...fast, getBrowser: fixture.getBrowser, interstitialSettleMs: 300 });

		expect(Date.now() - started).toBeGreaterThanOrEqual(600);
		expect(fixture.leasedEgress).toEqual(ALL_ROUTES);
		expect(archive.egress).toBe("reporting");
		expect(archive.url).toBe(realUrl);
	});

	test("named only by its header that nothing replaces sends the capture to the next route", async () => {
		const challengeHeaders: Array<Record<string, string>> = [{ "cf-mitigated": "challenge" }, { "x-vercel-mitigated": "challenge" }, { "x-amzn-waf-action": "challenge" }];
		for (const headers of challengeHeaders) {
			const fixture = archiveBrowserFixture({
				pageUrl: url,
				documentBodies: { [url]: challengeBody, [realUrl]: realBody },
				goto: async ({ egress }) => (egress === "reporting"
					? responseForNavigation(realUrl, 200, { contentType: "text/html" })
					: responseForNavigation(url, 403, { contentType: "text/html", headers })),
			});
			const archive = await firstPage({ url }, { ...fast, getBrowser: fixture.getBrowser, interstitialSettleMs: 100 });

			expect(fixture.leasedEgress).toEqual(ALL_ROUTES);
			expect(archive.egress).toBe("reporting");
			expect(archive.url).toBe(realUrl);
		}
	});

	test("that the solver passed is the site: no wait, no other route, even under the challenge's header", async () => {
		const fixture = archiveBrowserFixture({
			pageUrl: url,
			captchaState: () => "solved",
			pageState: () => ({ vendors: ["Cloudflare"] }),
			goto: async () => responseForNavigation(url, 200, { contentType: "text/html", headers: { "cf-mitigated": "challenge" } }),
		});
		const started = Date.now();
		const archive = await firstPage({ url }, { ...fast, getBrowser: fixture.getBrowser, interstitialSettleMs: 1_000 });

		expect(Date.now() - started).toBeLessThan(3_000);
		expect(fixture.leasedEgress).toEqual(["residential"]);
		expect(archive.url).toBe(url);
	});

	test("whose solver failed ends the wait at once and tries the next route", async () => {
		const fixture = archiveBrowserFixture({
			pageUrl: url,
			captchaState: () => "failed",
			pageState: () => ({ vendors: ["Cloudflare"] }),
			goto: async () => responseForNavigation(url, 403, { contentType: "text/html" }),
		});
		const started = Date.now();
		const failure = await firstPage({ url }, { ...fast, getBrowser: fixture.getBrowser, interstitialSettleMs: SLOW_SETTLE_MS }).catch((error: unknown) => error);

		expect(Date.now() - started).toBeLessThan(SLOW_SETTLE_MS);
		expect(failure).toBeInstanceOf(WebsiteCaptureFailedError);
		expect((failure as Error).message).toContain('HTTP 403 ("Captured title"), a Cloudflare challenge that did not pass via residential exit');
		expect(fixture.leasedEgress).toEqual(ALL_ROUTES);
	});

	test("that the solver is still working on is waited for, whatever the page is titled", async () => {
		let solving = true;
		const fixture = archiveBrowserFixture({
			pageUrl: url,
			title: (current) => (current === url ? "Secure Portal" : "Portal"),
			captchaState: () => (solving ? "solving" : "solved"),
			goto: async ({ replaceDocument }) => {
				setTimeout(() => {
					solving = false;
					replaceDocument(responseForNavigation(realUrl, 200, { contentType: "text/html" }));
				}, 30);
				return responseForNavigation(url, 200, { contentType: "text/html" });
			},
		});

		const archive = await firstPage({ url }, { ...fast, getBrowser: fixture.getBrowser, interstitialSettleMs: SLOW_SETTLE_MS });

		expect(archive.url).toBe(realUrl);
		expect(archive.navigationHops.map(({ url: hopUrl }) => hopUrl)).toEqual([realUrl]);
	});

	test("titled like one but carrying no vendor's challenge (a kit's fake gate) is the site, with no wait", async () => {
		const fixture = archiveBrowserFixture({
			pageUrl: url,
			title: "Just a moment...",
			documentBodies: { [url]: "<html><head><title>Just a moment...</title></head><body><div id=gate>Verify you are human</div></body></html>" },
			goto: async () => responseForNavigation(url, 200, { contentType: "text/html" }),
		});
		const started = Date.now();
		const archive = await firstPage({ url }, { ...fast, getBrowser: fixture.getBrowser, interstitialSettleMs: SLOW_SETTLE_MS });

		expect(Date.now() - started).toBeLessThan(SLOW_SETTLE_MS / 2);
		expect(fixture.leasedEgress).toEqual(["residential"]);
		expect(archive.url).toBe(url);
	});

	test("is no longer waited for once the visit is cancelled", async () => {
		const fixture = archiveBrowserFixture({
			pageUrl: url,
			pageState: () => ({ vendors: ["Cloudflare"] }),
			goto: async () => responseForNavigation(url, 403, { contentType: "text/html" }),
		});
		const controller = new AbortController();
		setTimeout(() => controller.abort(new Error("cancelled")), 100);
		const started = Date.now();
		const failure = await firstPage({ url, signal: controller.signal }, { ...fast, getBrowser: fixture.getBrowser, interstitialSettleMs: 20_000 }).catch((error: unknown) => error);

		expect(Date.now() - started).toBeLessThan(2_000);
		expect(failure).toBeInstanceOf(Error);
		expect(fixture.leasedEgress).toEqual(["residential"]);
		expect(fixture.captureSnapshotCount).toBe(0);
	});
});
