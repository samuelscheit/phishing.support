import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";

import { chromiumAvailable, launchTestChromium } from "../../browser/task/test_helpers";
import { archiveWebsite } from "./";

describe.skipIf(!chromiumAvailable)("the chain's raw answers, in a real browser", () => {
	test("keeps the body of an interstitial whose script leaves at once, stamps every answer with its arrival, and keeps the page's own identity", async () => {
		// A tracker redirect, a prize page that moves on from its <head> before it renders, and the destination.
		const interstitial = `<!DOCTYPE html><html><head><script>location.replace("/go?next=final")</script></head><body>Searching for your prize…</body></html>`;
		const destination = `<!DOCTYPE html><html><body><h1>Claim your reward</h1><p id="who"></p><script>document.getElementById("who").textContent = navigator.platform;</script></body></html>`;
		const userAgents: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch: (request) => {
				const { pathname } = new URL(request.url);
				userAgents.push(request.headers.get("user-agent") ?? "");
				if (pathname === "/click") return new Response(null, { status: 302, headers: { location: "/prize" } });
				if (pathname === "/prize") return new Response(interstitial, { headers: { "content-type": "text/html" } });
				if (pathname === "/go") return new Response(null, { status: 302, headers: { location: "/final" } });
				if (pathname === "/final") return new Response(destination, { headers: { "content-type": "text/html" } });
				return new Response("missing", { status: 404 });
			},
		});
		try {
			const origin = `http://127.0.0.1:${server.port}`;
			const visitor = { override: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36", platform: "MacIntel" }, screen: "desktop" as const };
			// The lure names its victim in the fragment, which the network never sees and the browser carries across the redirect.
			const archive = await archiveWebsite({ url: `${origin}/click#victim@mail.com`, visitor }, { scriptNavigationSettleMs: 1_500, renderSettleMs: 1_000, getBrowser: () => launchTestChromium() });

			expect(archive.navigationHops.map(({ url, status, redirectTo, bodyCaptured, contentCaptured }) => ({ url, status, redirectTo, bodyCaptured, contentCaptured }))).toEqual([
				{ url: `${origin}/click#victim@mail.com`, status: 302, redirectTo: `${origin}/prize`, bodyCaptured: undefined, contentCaptured: false },
				{ url: `${origin}/prize#victim@mail.com`, status: 200, redirectTo: `${origin}/go?next=final`, bodyCaptured: true, contentCaptured: false },
				{ url: `${origin}/go?next=final`, status: 302, redirectTo: `${origin}/final`, bodyCaptured: undefined, contentCaptured: false },
				{ url: `${origin}/final`, status: 200, redirectTo: undefined, bodyCaptured: true, contentCaptured: true },
			]);
			// The interstitial as the network delivered it: the page itself never kept it.
			expect(archive.hopBodies?.map(({ hopIndex, body }) => ({ hopIndex, body: body.toString("utf8") }))).toEqual([
				{ hopIndex: 1, body: interstitial },
				{ hopIndex: 3, body: destination },
			]);
			const times = archive.navigationHops.map(({ receivedAt }) => Date.parse(receivedAt ?? ""));
			expect(times.every(Number.isFinite)).toBe(true);
			expect(times).toEqual([...times].sort((a, b) => a - b));
			// Holding the answers changes nothing the site sees: every request and the page keep the visitor's identity.
			expect(new Set(userAgents)).toEqual(new Set([visitor.override.userAgent]));
			expect(archive.text.toString()).toContain("MacIntel");
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("a chain's pages render as they would unheld: cookies set along it reach the last page, compressed pages are kept decoded, a redirect's own body is not kept", async () => {
		const prize = `<!DOCTYPE html><html><head><script>location.replace("/final")</script></head><body>Searching…</body></html>`;
		const destination = `<!DOCTYPE html><html><body><h1>Claim</h1><p id="cookies"></p><script>document.getElementById("cookies").textContent = "cookies: " + document.cookie;</script></body></html>`;
		const server = Bun.serve({
			port: 0,
			fetch: (request) => {
				const { pathname } = new URL(request.url);
				if (pathname === "/click") return new Response("<html><body>Redirecting…</body></html>", { status: 302, headers: { location: "/prize", "set-cookie": "click=1; Path=/", "content-type": "text/html" } });
				if (pathname === "/prize") return new Response(gzipSync(prize), { headers: { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip", "set-cookie": "prize=2; Path=/" } });
				if (pathname === "/final") return new Response(destination, { headers: { "content-type": "text/html" } });
				return new Response("missing", { status: 404 });
			},
		});
		try {
			const origin = `http://127.0.0.1:${server.port}`;
			const archive = await archiveWebsite({ url: `${origin}/click` }, { scriptNavigationSettleMs: 1_500, renderSettleMs: 1_000, getBrowser: () => launchTestChromium() });

			expect(archive.navigationHops.map(({ url, status, bodyCaptured }) => ({ url, status, bodyCaptured }))).toEqual([
				{ url: `${origin}/click`, status: 302, bodyCaptured: undefined },
				{ url: `${origin}/prize`, status: 200, bodyCaptured: true },
				{ url: `${origin}/final`, status: 200, bodyCaptured: true },
			]);
			expect(archive.hopBodies?.map(({ hopIndex, body }) => ({ hopIndex, body: body.toString("utf8") }))).toEqual([
				{ hopIndex: 1, body: prize },
				{ hopIndex: 2, body: destination },
			]);
			expect(archive.text.toString()).toContain("cookies: click=1; prize=2");
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("a page streaming forever is captured as far as the cap without waiting on it, and keeps no body", async () => {
		const cancelled: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch: (request) => {
				const { pathname } = new URL(request.url);
				if (pathname === "/lure") return new Response(null, { status: 302, headers: { location: "/tarpit" } });
				if (pathname !== "/tarpit") return new Response("missing", { status: 404 });
				let started = false;
				return new Response(new ReadableStream({
					pull: (controller) => {
						// Filler that draws nothing: a page tens of MB tall is a screenshot no browser takes.
						controller.enqueue(new TextEncoder().encode(started ? "y".repeat(65_536) : "<!DOCTYPE html><html><head><title>Offer</title></head><body><h1>Your exclusive offer</h1><!--"));
						started = true;
					},
					cancel: () => { cancelled.push("tarpit"); },
				}), { headers: { "content-type": "text/html" } });
			},
		});
		try {
			const origin = `http://127.0.0.1:${server.port}`;
			const started = Date.now();
			const archive = await archiveWebsite({ url: `${origin}/lure` }, { scriptNavigationSettleMs: 500, renderSettleMs: 1_000, getBrowser: () => launchTestChromium() });

			// Far within the body's own time bound: the cap ends the read, not the clock.
			expect(Date.now() - started).toBeLessThan(15_000);
			expect(archive.navigationHops.map(({ url, status, bodyCaptured, contentCaptured }) => ({ url, status, bodyCaptured, contentCaptured }))).toEqual([
				{ url: `${origin}/lure`, status: 302, bodyCaptured: undefined, contentCaptured: false },
				{ url: `${origin}/tarpit`, status: 200, bodyCaptured: undefined, contentCaptured: true },
			]);
			expect(archive.hopBodies ?? []).toEqual([]);
			expect(archive.text.toString()).toContain("Your exclusive offer");
			expect(archive.screenshotPng?.byteLength).toBeGreaterThan(0);
			expect(cancelled).toEqual(["tarpit"]);
		} finally {
			server.stop(true);
		}
	}, 60_000);
});
