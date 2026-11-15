import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import puppeteer from "rebrowser-puppeteer-core";

import { archiveWebsite } from "./website_archive";

const chromiumExecutable = process.env.PHISHING_TEST_CHROMIUM
	?? `${homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const chromiumAvailable = await Bun.file(chromiumExecutable).exists();
const launch = async () => puppeteer.launch({ executablePath: chromiumExecutable, headless: true, args: ["--no-first-run"] });
const fast = { scriptNavigationSettleMs: 20, renderSettleMs: 1_000, humanCheckMs: 3_000 } as const;

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

	test("is dismissed as a visitor would, the site behind it captured, and the warning recorded", async () => {
		const { server, hits, origin } = serve({
			"/game-copier/": (request) => (request.headers.get("cookie")?.includes("cf_bypass=1")
				? html("<h1>Game to Studio. One export.</h1>")
				: warning("/game-copier/")),
			"/cdn-cgi/phish-bypass": (request) => new Response(null, { status: 302, headers: { location: new URL(request.url).searchParams.get("original_path")!, "set-cookie": "cf_bypass=1; path=/" } }),
		});
		try {
			const archive = await archiveWebsite({ url: `${origin}/game-copier/` }, { ...fast, getBrowser: launch, errorDocumentSettleMs: 5_000 });
			expect(archive.providerWarning).toEqual({ provider: "Cloudflare", warning: "Suspected Malware" });
			expect(archive.text.toString()).toContain("Game to Studio. One export.");
			expect(archive.navigationHops.at(-1)).toMatchObject({ url: `${origin}/game-copier/`, status: 200, contentCaptured: true });
			expect(hits).toContain("/cdn-cgi/phish-bypass");
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("an ordinary error page is no warning to dismiss", async () => {
		const { server, origin } = serve({ "/": () => html("<h1>Forbidden</h1><form action=/search><button>Search</button></form>", { status: 403 }) });
		try {
			await expect(archiveWebsite({ url: `${origin}/` }, { ...fast, getBrowser: launch, errorDocumentSettleMs: 500 })).rejects.toThrow("HTTP 403");
		} finally {
			server.stop(true);
		}
	}, 60_000);
});

