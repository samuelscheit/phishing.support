import { describe, expect, test } from "bun:test";

import { WebsiteCaptureFailedError } from "../archive/errors";
import { firstPage } from "../archive/test_fixture";
import { chromiumAvailable, launchTestChromium } from "../../browser/task/test_helpers";

const fast = { renderSettleMs: 1_000 } as const;

const html = (body: string, init: ResponseInit = {}, title = "RBXCore — Game Copier") => new Response(`<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`, { ...init, headers: { "content-type": "text/html; charset=utf-8", ...init.headers } });

function serve(pages: Record<string, (request: Request) => Response | Promise<Response>>) {
	const hits: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: (request) => {
			const { pathname } = new URL(request.url);
			hits.push(pathname);
			return (pages[pathname] ?? (() => new Response("not found", { status: 404 })))(request);
		},
	});
	return { server, hits, origin: `http://127.0.0.1:${server.port}` };
}

describe.skipIf(!chromiumAvailable)("a provider's warning page before the site, in a real browser", () => {
	/**
	 * Cloudflare's "Suspected Malware" interstitial as rbxcore.pro served it:
	 * HTTP 403, a form to /cdn-cgi/phish-bypass whose button unlocks once its
	 * Turnstile passes, then a redirect to the site with a bypass cookie.
	 */
	const warning = (path: string) => html(`<h1>Warning</h1><h2>Suspected Malware</h2><p>This website has been reported for potentially distributing malware.</p>
<form action="/cdn-cgi/phish-bypass" method="GET"><input type="hidden" name="atok" value="token-1"><input type="hidden" name="original_path" value="${path}">
<button type="submit" id="bypass-button" disabled>Ignore & Proceed</button>
<div class="cf-turnstile"><input type="hidden" name="cf-turnstile-response" value=""></div></form>
<script>setTimeout(() => { document.querySelector("[name=cf-turnstile-response]").value = "0.token"; document.getElementById("bypass-button").disabled = false; }, 300);</script>`, { status: 403 }, "Suspected Malware | Cloudflare");

	for (const [warningStatus, siteStatus] of [[403, 200], [200, 500]] as const) {
		test(`answering ${warningStatus}, is dismissed as a visitor would, the site behind it captured under HTTP ${siteStatus}, and the warning recorded`, async () => {
			const { server, hits, origin } = serve({
				"/game-copier/": (request) => (request.headers.get("cookie")?.includes("cf_bypass=1")
					? html("<h1>Game to Studio. One export.</h1>", { status: siteStatus })
					: new Response(warning("/game-copier/").body, { status: warningStatus, headers: { "content-type": "text/html; charset=utf-8" } })),
				"/cdn-cgi/phish-bypass": (request) => new Response(null, { status: 302, headers: { location: new URL(request.url).searchParams.get("original_path")!, "set-cookie": "cf_bypass=1; path=/" } }),
			});
			try {
				const archive = await firstPage({ url: `${origin}/game-copier/` }, { ...fast, getBrowser: () => launchTestChromium(), interstitialSettleMs: 5_000 });
				expect(archive.providerWarning).toEqual({ provider: "Cloudflare", warning: "Suspected Malware" });
				expect(archive.text.toString()).toContain("Game to Studio. One export.");
				// The dismissed warning is no hop of the visitor's chain: it starts with the bypass that replaced it.
				expect(archive.navigationHops.map(({ url, status, contentCaptured }) => ({ url: url.replace(/\?.*/, ""), status, contentCaptured }))).toEqual([
					{ url: `${origin}/cdn-cgi/phish-bypass`, status: 302, contentCaptured: false },
					{ url: `${origin}/game-copier/`, status: siteStatus, contentCaptured: true },
				]);
				expect(hits).toContain("/cdn-cgi/phish-bypass");
			} finally {
				server.stop(true);
			}
		}, 60_000);
	}

	test("a Turnstile the browser's solver takes long over is waited for until the button it unlocks can be pressed", async () => {
		// Well past the 5 s the capture once gave a locked button.
		const solving = (path: string) => html(`<h2>Suspected Phishing</h2>
<form action="/cdn-cgi/phish-bypass" method="GET"><input type="hidden" name="original_path" value="${path}">
<button type="submit" id="bypass-button" disabled>Ignore & Proceed</button></form>
<script>
document.documentElement.setAttribute("data-captcha-state", "solving");
document.documentElement.setAttribute("data-captcha-detail", "turnstile");
setTimeout(() => { document.getElementById("bypass-button").disabled = false; document.documentElement.setAttribute("data-captcha-state", "solved"); }, 7_000);
</script>`, { status: 403 }, "Suspected Phishing | Cloudflare");
		const { server, hits, origin } = serve({
			"/login/": (request) => (request.headers.get("cookie")?.includes("cf_bypass=1") ? html("<h1>Sign in</h1>") : solving("/login/")),
			"/cdn-cgi/phish-bypass": (request) => new Response(null, { status: 302, headers: { location: new URL(request.url).searchParams.get("original_path")!, "set-cookie": "cf_bypass=1; path=/" } }),
		});
		try {
			const archive = await firstPage({ url: `${origin}/login/` }, { ...fast, getBrowser: () => launchTestChromium(), interstitialSettleMs: 5_000 });
			expect(archive.providerWarning).toEqual({ provider: "Cloudflare", warning: "Suspected Phishing" });
			expect(archive.text.toString()).toContain("Sign in");
			expect(hits).toContain("/cdn-cgi/phish-bypass");
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("an ordinary page answering 403 is no warning to dismiss: it is captured as the site, without waiting", async () => {
		const { server, origin } = serve({ "/": () => html("<h1>Forbidden</h1><form action=/search><button>Search</button></form>", { status: 403 }) });
		try {
			const started = Date.now();
			const archive = await firstPage({ url: `${origin}/` }, { ...fast, getBrowser: () => launchTestChromium(), interstitialSettleMs: 20_000 });
			expect(Date.now() - started).toBeLessThan(15_000);
			expect(archive.providerWarning).toBeUndefined();
			expect(archive.text.toString()).toContain("Forbidden");
			expect(archive.navigationHops).toEqual([expect.objectContaining({ url: `${origin}/`, status: 403, bodyCaptured: true, contentCaptured: true })]);
			expect(archive.hopBodies?.[0]?.body.toString()).toContain("<h1>Forbidden</h1>");
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("a Cloudflare challenge, known by its inline options and not its title, is waited for until it reloads into the site", async () => {
		const challenge = html(`<h1>Проверка браузера</h1><script>window._cf_chl_opt = { cType: "managed" };
setTimeout(() => { document.cookie = "cf_clearance=1; path=/"; location.reload(); }, 600);</script>`, { status: 403 }, "Один момент…");
		const { server, hits, origin } = serve({ "/": (request) => (request.headers.get("cookie")?.includes("cf_clearance=1") ? html("<h1>Sign in</h1><input type=password>", { status: 500 }) : challenge) });
		try {
			const archive = await firstPage({ url: `${origin}/` }, { ...fast, getBrowser: () => launchTestChromium(), interstitialSettleMs: 20_000 });
			expect(archive.text.toString()).toContain("Sign in");
			expect(archive.navigationHops).toEqual([expect.objectContaining({ url: `${origin}/`, status: 500, contentCaptured: true, bodyCaptured: true })]);
			expect(hits.filter((path) => path === "/")).toHaveLength(2);
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("a kit's page embedding Cloudflare's real Turnstile widget is the site: no wait, no other route", async () => {
		const kit = html(`<h1>Verify to continue</h1><div class="cf-turnstile" data-sitekey="0x4AAAAAAA"></div>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script><a href="/next">Continue</a>`, {}, "Just a moment...");
		const { server, hits, origin } = serve({ "/": () => kit });
		try {
			const started = Date.now();
			const archive = await firstPage({ url: `${origin}/` }, { ...fast, getBrowser: () => launchTestChromium(), interstitialSettleMs: 20_000 });
			expect(Date.now() - started).toBeLessThan(15_000);
			expect(archive.text.toString()).toContain("Verify to continue");
			expect(hits.filter((path) => path === "/")).toHaveLength(1);
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("DDoS-Guard's browser check, known by its own elements, is waited for until it reloads into the site", async () => {
		const check = html(`<div id="ddg-l10n-title">Проверка браузера перед переходом на сайт</div><img src="/.well-known/ddos-guard/check?context=free_splash" alt="">
<script>setTimeout(() => { document.cookie = "__ddg2=1; path=/"; location.reload(); }, 600);</script>`, { status: 403, headers: { server: "ddos-guard" } }, "DDoS-Guard");
		const { server, hits, origin } = serve({ "/": (request) => (request.headers.get("cookie")?.includes("__ddg2=1") ? html("<h1>Sign in</h1><input type=password>", { headers: { server: "ddos-guard" } }) : check) });
		try {
			const archive = await firstPage({ url: `${origin}/` }, { ...fast, getBrowser: () => launchTestChromium(), interstitialSettleMs: 20_000 });
			expect(archive.text.toString()).toContain("Sign in");
			expect(archive.navigationHops).toEqual([expect.objectContaining({ url: `${origin}/`, status: 200, contentCaptured: true })]);
			expect(hits.filter((path) => path === "/")).toHaveLength(2);
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("a bare 403 Forbidden page is the network turned away: every route is tried, then the capture fails", async () => {
		const { server, hits, origin } = serve({ "/": () => html("<h1>403 Forbidden</h1><hr>nginx", { status: 403 }, "403 Forbidden") });
		try {
			const failure = await firstPage({ url: `${origin}/` }, { ...fast, getBrowser: () => launchTestChromium(), interstitialSettleMs: 20_000 }).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(WebsiteCaptureFailedError);
			expect((failure as Error).message).toContain('HTTP 403 ("403 Forbidden"), a page blocking this network via residential exit');
			expect(hits.filter((path) => path === "/")).toHaveLength(3);
		} finally {
			server.stop(true);
		}
	}, 60_000);
});

