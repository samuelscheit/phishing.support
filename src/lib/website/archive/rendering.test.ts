import { describe, expect, test } from "bun:test";
import { TimeoutError } from "rebrowser-puppeteer-core";

import { archiveWebsite } from "./";
import { archiveBrowserFixture, fast, responseForNavigation } from "./test_fixture";

describe("rendering", () => {
	// A Flazio site builder page: the document is a shell, and the login form
	// arrives through XHR after DOMContentLoaded.
	const url = "https://microsoftoutlook.flazio.online/";
	const form = "<form><h1>Melden Sie sich bei Ihrem Microsoft-Konto an</h1><input type=\"email\" placeholder=\"E-Mail-Adresse\"><input type=\"password\" placeholder=\"Passwort\"></form>";

	test("waits for the page's own requests to finish so the capture holds the form they render", async () => {
		const fixture = archiveBrowserFixture({
			pageUrl: url,
			networkIdle: async ({ render }) => {
				await Bun.sleep(5);
				render(form);
			},
		});

		const archive = await archiveWebsite({ url }, { ...fast, getBrowser: fixture.getBrowser });

		expect(archive.text.toString()).toContain("Melden Sie sich bei Ihrem Microsoft-Konto an");
		expect(archive.text.toString()).toContain("E-Mail-Adresse");
		expect(archive.text.toString()).toContain("Passwort");
		expect(fixture.networkIdleWaits).toEqual([{ idleTime: 1_000, concurrency: 2, timeout: 10_000 }]);
	});

	test("a page that never goes quiet is captured as it stands once the bound passes", async () => {
		const fixture = archiveBrowserFixture({
			pageUrl: url,
			networkIdle: async ({ timeout, render }) => {
				render(form);
				await Bun.sleep(timeout ?? 0);
				throw new TimeoutError(`Timed out after waiting ${timeout}ms`);
			},
		});

		const archive = await archiveWebsite({ url }, { ...fast, renderSettleMs: 20, getBrowser: fixture.getBrowser });

		expect(archive.text.toString()).toContain("E-Mail-Adresse");
		expect(fixture.networkIdleWaits).toEqual([{ idleTime: 20, concurrency: 2, timeout: 20 }]);
		expect(fixture.leasedEgress).toEqual(["residential"]);
		expect(fixture.screenshotCount).toBe(1);
	});

	test("a browser failure while waiting is not mistaken for a slow page", async () => {
		const fixture = archiveBrowserFixture({
			pageUrl: url,
			networkIdle: async () => { throw new Error("Protocol error: Target closed"); },
		});

		await expect(archiveWebsite({ url }, { ...fast, getBrowser: fixture.getBrowser })).rejects.toThrow("Target closed");
		// The residential exit's failure of any kind falls through; Tor's browser failure is thrown.
		expect(fixture.leasedEgress).toEqual(["residential", "phishing"]);
		expect(fixture.screenshotCount).toBe(0);
		expect(fixture.closeCount).toBe(2);
	});

	test("waits on the document a cloaker's script navigated to, not on the interstitial", async () => {
		const interstitial = "https://interstitial.example/";
		const events: string[] = [];
		const fixture = archiveBrowserFixture({
			pageUrl: interstitial,
			goto: async ({ replaceDocument }) => {
				setTimeout(() => {
					events.push("script navigation");
					replaceDocument(responseForNavigation("https://interstitial.example/login", 200, { contentType: "text/html" }));
				}, 5);
				return responseForNavigation(interstitial, 200, { contentType: "text/html" });
			},
			networkIdle: async ({ render }) => {
				events.push("render");
				render(form);
			},
		});

		const archive = await archiveWebsite({ url: interstitial }, { scriptNavigationSettleMs: 1_100, getBrowser: fixture.getBrowser });

		expect(events).toEqual(["script navigation", "render"]);
		expect(archive.url).toBe("https://interstitial.example/login");
		expect(archive.text.toString()).toContain("E-Mail-Adresse");
	});

	test("keeps the raw body of every page of the chain as the network answered it: the interstitial a script left at once too, not the redirects", async () => {
		// The design's example chain: a tracker 302s to a prize page whose script moves on at once, through another tracker, to the destination.
		const tracker = "https://wtrck.com/click?id=1";
		const prize = "https://ultimateprizesearch.com/";
		const destination = "https://zatos.com/";
		const prizeBody = `<html><body><script>location.replace("https://miamitrk.com/c?d=zatos")</script>Searching for your prize…</body></html>`;
		const destinationBody = "<html><body><h1>Zatos</h1></body></html>";
		const fixture = archiveBrowserFixture({
			pageUrl: tracker,
			documentBodies: { [tracker]: "Found", [prize]: prizeBody, [destination]: destinationBody },
			goto: async ({ replaceDocument }) => {
				setTimeout(() => replaceDocument(responseForNavigation(destination, 200, {
					contentType: "text/html",
					redirects: [{ url: "https://miamitrk.com/c?d=zatos", status: 302, location: destination }],
				})), 5);
				return responseForNavigation(prize, 200, { contentType: "text/html", redirects: [{ url: tracker, status: 302, location: prize }] });
			},
		});

		const archive = await archiveWebsite({ url: tracker, visitor: { override: { userAgent: "Mozilla/5.0 (Macintosh) Chrome/157", platform: "MacIntel" }, screen: "desktop" } }, { scriptNavigationSettleMs: 200, getBrowser: fixture.getBrowser });

		expect(archive.navigationHops.map(({ index, url, status, redirectTo, contentCaptured, bodyCaptured }) => ({ index, url, status, redirectTo, contentCaptured, bodyCaptured }))).toEqual([
			{ index: 0, url: tracker, status: 302, redirectTo: prize, contentCaptured: false, bodyCaptured: undefined },
			// Its script, not its status, sent the visitor on: the hop names where to.
			{ index: 1, url: prize, status: 200, redirectTo: "https://miamitrk.com/c?d=zatos", contentCaptured: false, bodyCaptured: true },
			{ index: 2, url: "https://miamitrk.com/c?d=zatos", status: 302, redirectTo: destination, contentCaptured: false, bodyCaptured: undefined },
			{ index: 3, url: destination, status: 200, redirectTo: undefined, contentCaptured: true, bodyCaptured: true },
		]);
		// Every answer is stamped with when the network layer held it, redirects included, in order.
		const times = archive.navigationHops.map(({ receivedAt }) => Date.parse(receivedAt ?? ""));
		expect(times.every(Number.isFinite)).toBe(true);
		expect(times).toEqual([...times].sort((a, b) => a - b));
		expect(archive.hopBodies?.map(({ hopIndex, body }) => ({ hopIndex, body: body.toString("utf8") }))).toEqual([
			{ hopIndex: 1, body: prizeBody },
			{ hopIndex: 3, body: destinationBody },
		]);
		// The holding session presents the visitor before it holds anything: Chromium takes a held navigation's platform from it.
		const commands = fixture.cdpCommands.map(({ method }) => method).filter((method) => method.startsWith("Fetch.enable") || method === "Emulation.setUserAgentOverride");
		expect(commands.slice(0, 2)).toEqual(["Emulation.setUserAgentOverride", "Fetch.enable"]);
		expect(fixture.cdpCommands.find(({ method }) => method === "Emulation.setUserAgentOverride")?.params).toEqual({ userAgent: "Mozilla/5.0 (Macintosh) Chrome/157", platform: "MacIntel" });
		// Only pages are read, each as a stream it closes, and answered with exactly the bytes read; the redirects go on
		// untouched. Every held response goes on once, and the tab is let go at the end.
		expect(fixture.heldResponses()).toEqual(["continued", "fulfilled", "continued", "fulfilled"]);
		expect(fixture.openStreams).toBe(0);
		expect(fixture.cdpCommands.filter(({ method }) => method === "IO.close")).toHaveLength(2);
		const fulfilled = fixture.cdpCommands.filter(({ method }) => method === "Fetch.fulfillRequest").map(({ params }) => params as { responseCode: number; responseHeaders: unknown; body: string });
		expect(fulfilled.map(({ responseCode, responseHeaders, body }) => ({ responseCode, responseHeaders, body: Buffer.from(body, "base64").toString("utf8") }))).toEqual([
			{ responseCode: 200, responseHeaders: [{ name: "content-type", value: "text/html" }], body: prizeBody },
			{ responseCode: 200, responseHeaders: [{ name: "content-type", value: "text/html" }], body: destinationBody },
		]);
		expect(fixture.cdpCommands.filter(({ method }) => method === "Fetch.disable")).toHaveLength(1);
	});
});
