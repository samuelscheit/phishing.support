import { describe, expect, test } from "bun:test";
import puppeteer from "rebrowser-puppeteer-core";

import { createExfiltrationCanaries } from "../exfiltration/canaries";
import type { ExfiltrationCanaries } from "../exfiltration/types";
import { archiveWebsite } from "../website_archive";
import type { ChatModel } from "../browser_task/agent";
import { chromiumAvailable, chromiumExecutable, refIn, ScriptedModel, StalledModel, type ScriptedTurn } from "../browser_task/test_helpers";
import { stepActions, taskAgentVisit, type VisitAgent } from "./agent";
import type { SiteVisitLiveEvent } from "./visit";

const launch = async () => puppeteer.launch({ executablePath: chromiumExecutable, headless: true, args: ["--no-first-run"] });
const fast = { scriptNavigationSettleMs: 20, renderSettleMs: 800, visitPollMs: 150, visitStepQuietMs: 400 } as const;

const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("the kit's extension")]);
const html = (body: string, title = "Roblox") => new Response(`<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });

/**
 * A two-step kit: a Roblox sign-in whose form posts to the kit's collector,
 * then a "verify your account" page whose dialog hands out a ZIP the visitor
 * is told to load into Chrome.
 */
function serveKit() {
	const posts: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const { pathname } = new URL(request.url);
			if (pathname === "/collect" && request.method === "POST") {
				posts.push(await request.text());
				return Response.redirect("/verify", 302);
			}
			if (pathname === "/verify") {
				return html(`<h1>Verify your account</h1><p>Download the Roblox Verifier and load it in Chrome.</p>
<button id="open">Get Verifier</button><div id="dialog" style="opacity:0;pointer-events:none"><button id="dl">Download Verifier.zip</button></div>
<script>document.getElementById("open").onclick=()=>{const d=document.getElementById("dialog");d.style.opacity=1;d.style.pointerEvents="auto"};
document.getElementById("dl").onclick=()=>{const a=document.createElement("a");a.href="/Verifier.zip";a.download="Verifier.zip";a.click()};</script>`, "Roblox — Verify");
			}
			if (pathname === "/Verifier.zip") return new Response(ZIP, { headers: { "content-type": "application/zip" } });
			return html(`<h1>Log in to Roblox</h1><form method="POST" action="/collect"><input name="username" placeholder="Username"><input type="password" name="password" placeholder="Password"><button>Log In</button></form>`);
		},
	});
	return { server, posts, url: `http://127.0.0.1:${server.port}/` };
}

/**
 * The walk a victim takes through the kit, as model turns: sign in with the
 * synthetic email and the password placeholder, open the dialog, take the
 * file, report. Each turn reads its refs from the observation.
 */
function kitWalk(canaries: ExfiltrationCanaries): ScriptedTurn[] {
	return [
		(page) => ({
			text: "The kit asks to log in; I enter the synthetic values.",
			calls: [
				{ name: "type", arguments: { ref: refIn(page, 'textbox "Username"'), text: canaries.email } },
				{ name: "type", arguments: { ref: refIn(page, 'textbox "Password"'), text: "{{secret:password}}" } },
				{ name: "click", arguments: { ref: refIn(page, 'button "Log In"') } },
			],
		}),
		(page) => {
			expect(page).toContain("Verify your account");
			return { text: "The verify page offers a verifier.", calls: [{ name: "click", arguments: { ref: refIn(page, 'button "Get Verifier"') } }] };
		},
		(page) => ({ calls: [{ name: "click", arguments: { ref: refIn(page, 'button "Download Verifier.zip"') } }] }),
		() => ({ calls: [{ name: "done", arguments: { result: { submissionsAttempted: 1, downloadsStarted: 1, asksForPhone: false, blockedByChallenge: false, stoppedReason: "Downloaded the verifier." }, summary: "Done." } }] }),
	];
}

/**
 * A shared-note lure whose every step opens a new tab, as thunknotes.com's
 * "AVAA ASIAKIRJA" did (production case 381535952033550429): the note links
 * to the document with target=_blank (through a redirect), the document offers
 * its file in yet another tab and opens its sign-in with window.open, and the
 * sign-in's last page closes itself, back to the document.
 */
function serveNewTabKit() {
	const posts: string[] = [];
	/** Who the new tab said it was: its first request's User-Agent header, and what its first script read. */
	const seenAs: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const { pathname, searchParams } = new URL(request.url);
			if (pathname === "/d/abc") return Response.redirect("/document", 302);
			if (pathname === "/seen") {
				seenAs.push(`script: ${searchParams.get("platform")} ${searchParams.get("width")}x${searchParams.get("height")}`);
				return new Response("");
			}
			if (pathname === "/document") {
				seenAs.push(`header: ${request.headers.get("user-agent")}`);
				return html(`<h1>Invoice 4711</h1><p>2 pages awaiting review.</p><script src="/viewer.js"></script>
<script>fetch("/seen?platform=" + navigator.platform + "&width=" + screen.width + "&height=" + screen.height)</script>
<a href="/Invoice-4711.zip" target="_blank">Download the invoice</a> <button onclick="window.open('/signin')">Sign in to view</button>`, "Document viewer");
			}
			if (pathname === "/viewer.js") return new Response("window.viewer = 1;", { headers: { "content-type": "application/javascript" } });
			if (pathname === "/Invoice-4711.zip") return new Response(ZIP, { headers: { "content-type": "application/zip" } });
			if (pathname === "/signin") return html(`<h1>Sign in to view the document</h1><form method="POST" action="/collect"><input name="email" placeholder="Email"><input type="password" name="password" placeholder="Password"><button>Sign in</button></form>`, "Sign in");
			if (pathname === "/collect" && request.method === "POST") {
				posts.push(await request.text());
				return html(`<h1>Signed in</h1><button onclick="window.close()">Back to the document</button>`, "Signed in");
			}
			return html(`<h1>EG-Trading Oy</h1><p>You have a new document awaiting review.</p><a href="/d/abc" target="_blank">Open document</a>`, "Shared note");
		},
	});
	return { server, posts, seenAs, url: `http://127.0.0.1:${server.port}/` };
}

class FailingModel implements ChatModel {
	readonly id = "test/failing";
	async complete(): Promise<never> {
		throw new Error("model answered HTTP 401: invalid api_key=sk-live-123456789");
	}
}

describe.skipIf(!chromiumAvailable)("a site visit, in a real browser, walked by the task agent", () => {
	test("records each page the agent reaches, where the synthetic values went, and the file it downloaded, live", async () => {
		const { server, posts, url } = serveKit();
		const canaries = createExfiltrationCanaries();
		const model = new ScriptedModel(kitWalk(canaries));
		const live: SiteVisitLiveEvent[] = [];
		const archive = await archiveWebsite({ url, keepSession: true }, { ...fast, getBrowser: launch });
		try {
			const recording = await archive.session!.visit({ canaries, agent: taskAgentVisit(() => model), live: (event) => live.push(event) });
			expect(recording.agent).toMatchObject({ outcome: "completed", report: { submissionsAttempted: 1, downloadsStarted: 1, stoppedReason: "Downloaded the verifier." } });

			// The agent continued on the captured tab: its first observation is the captured sign-in page.
			expect(model.seen()).toContain(`The browser is already on its page (${url})`);
			expect(model.seen()).toContain(`Current page:\nURL: ${url}\nTitle: Roblox`);

			// The sign-in was submitted to the kit's collector with the real synthetic password, and the network recording shows it.
			expect(posts).toHaveLength(1);
			expect(new URLSearchParams(posts[0]).get("password")).toBe(canaries.password);
			const submitted = recording.requests.find((request) => request.method === "POST" && request.url === `${url}collect`);
			expect(new URLSearchParams(submitted?.postData).get("password")).toBe(canaries.password);

			// The verify page is a step, captured with the hops since the sign-in.
			const verify = recording.steps.find(({ step }) => step.url === `${url}verify`)!;
			expect(verify.step.text.toString()).toContain("Verify your account");
			expect(verify.step.navigationHops.map(({ url: hopUrl, status, contentCaptured }) => ({ hopUrl, status, contentCaptured }))).toEqual([
				{ hopUrl: `${url}collect`, status: 302, contentCaptured: false },
				{ hopUrl: `${url}verify`, status: 200, contentCaptured: true },
			]);

			// The file from the dialog was taken, never saved.
			expect(recording.downloads).toEqual([expect.objectContaining({ url: `${url}Verifier.zip`, fileName: "Verifier.zip", bytes: ZIP, userAgent: expect.stringContaining("Windows NT 10.0") })]);

			expect(live.some((event) => event.type === "browser.frame" && event.jpeg.length > 100)).toBeTrue();
			expect(live.filter((event) => event.type === "browser.step").map((event) => (event as { url: string }).url)).toContain(`${url}verify`);
			expect(live).toContainEqual({ type: "browser.download", fileName: "Verifier.zip", url: `${url}Verifier.zip` });
			// The request that carried a value keeps the page it came from and the server's answer.
			// The collector answered the form with a redirect: that redirect is the recorded answer.
			expect(submitted).toMatchObject({ documentUrl: expect.stringContaining(url), requestHeaders: { "content-type": "application/x-www-form-urlencoded" }, response: { status: 302, receivedAt: expect.any(String) } });

			// The live log reads the agent's thoughts and what each action did.
			expect(live).toContainEqual({ type: "browser.action", kind: "thought", text: "The kit asks to log in; I enter the synthetic values." });
			expect(recording.agent.actions.map((action) => action.kind)).toEqual(["thought", "type", "type", "click", "thought", "click", "click", "done"]);
			expect(recording.agent.actions.find((action) => action.kind === "click")?.text).toStartWith("clicked e");

			// The password never reached the model: only its placeholder did.
			expect(model.seen()).not.toContain(canaries.password);
			expect(model.seen()).toContain("{{secret:password}}");
			// The evidence and the live log say what was entered where and when: the element's ref, the
			// synthetic value the browser typed (a secret with the placeholder the agent typed it as), and the time its step acted.
			const typedPassword = { id: "1.2", kind: "type", text: `typed into e2; its value is now ${JSON.stringify(canaries.password)}`, selector: "e2", value: canaries.password, typedAs: "{{secret:password}}", at: expect.any(String) };
			expect(recording.agent.actions).toContainEqual(typedPassword);
			expect(live).toContainEqual({ type: "browser.action", kind: "type", text: typedPassword.text });
			expect(recording.agent.actions).toContainEqual(expect.objectContaining({ id: "1.1", kind: "type", selector: "e1", value: canaries.email }));
			const times = recording.agent.actions.map((action) => action.at!);
			expect(times.every((at) => !Number.isNaN(Date.parse(at)))).toBe(true);
			expect(times).toEqual([...times].sort());
		} finally {
			await archive.session?.close();
			server.stop(true);
		}
	}, 60_000);

	test("follows the walk into every tab the site opens: a target=_blank link, a file in a new tab, window.open, and back when that tab closes", async () => {
		const { server, posts, seenAs, url } = serveNewTabKit();
		const canaries = createExfiltrationCanaries();
		const model = new ScriptedModel([
			(page) => ({ calls: [{ name: "click", arguments: { ref: refIn(page, 'link "Open document"') } }] }),
			(page) => {
				expect(page).toContain("Invoice 4711");
				return { calls: [{ name: "click", arguments: { ref: refIn(page, 'link "Download the invoice"') } }] };
			},
			// The file's tab may still show empty; the agent waits, as it does on a page still loading.
			() => ({ calls: [{ name: "wait", arguments: { seconds: 1 } }] }),
			(page) => {
				// The tab that only delivered the file was closed, as Chrome closes it: the agent is back on the document.
				expect(page).toContain("Invoice 4711");
				return { calls: [{ name: "click", arguments: { ref: refIn(page, 'button "Sign in to view"') } }] };
			},
			(page) => {
				expect(page).toContain("Sign in to view the document");
				return {
					calls: [
						{ name: "type", arguments: { ref: refIn(page, 'textbox "Email"'), text: canaries.email } },
						{ name: "type", arguments: { ref: refIn(page, 'textbox "Password"'), text: "{{secret:password}}" } },
						{ name: "click", arguments: { ref: refIn(page, 'button "Sign in"') } },
					],
				};
			},
			// A model's turn takes seconds: the signed-in page stays long enough to be a step.
			(page) => {
				expect(page).toContain("Signed in");
				return { calls: [{ name: "wait", arguments: { seconds: 1 } }] };
			},
			(page) => ({ calls: [{ name: "click", arguments: { ref: refIn(page, 'button "Back to the document"') } }] }),
			(page) => {
				expect(page).toContain("Invoice 4711");
				return { calls: [{ name: "done", arguments: { result: { submissionsAttempted: 1, downloadsStarted: 1, asksForPhone: false, blockedByChallenge: false, stoppedReason: "Signed in and downloaded the invoice." }, summary: "Done." } }] };
			},
		]);
		const live: SiteVisitLiveEvent[] = [];
		const archive = await archiveWebsite({ url, keepSession: true }, { ...fast, getBrowser: launch });
		try {
			const recording = await archive.session!.visit({ canaries, agent: taskAgentVisit(() => model), live: (event) => live.push(event) });
			expect(recording.agent).toMatchObject({ outcome: "completed", report: { stoppedReason: "Signed in and downloaded the invoice." } });
			const steps = recording.steps.map(({ step }) => step);
			expect(steps.map((step) => step.url)).toEqual([`${url}document`, `${url}signin`, `${url}collect`, `${url}document`]);

			// The document opened in a new tab is a step of its own: its screenshot, text, the redirect
			// that led to it, and the script its first load ran, all recorded from the tab's first request.
			const [document, signin, signedIn, backToDocument] = steps;
			expect(document!.text.toString()).toContain("Invoice 4711");
			expect(document!.screenshotPng?.byteLength).toBeGreaterThan(1_000);
			expect(document!.navigationHops.map(({ url: hopUrl, status, contentCaptured }) => ({ hopUrl, status, contentCaptured }))).toEqual([
				{ hopUrl: `${url}d/abc`, status: 302, contentCaptured: false },
				{ hopUrl: `${url}document`, status: 200, contentCaptured: true },
			]);
			expect(document!.kitResources).toEqual([expect.objectContaining({ url: `${url}viewer.js`, mimeType: "application/javascript" })]);
			expect(signin!.navigationHops.map(({ url: hopUrl, status }) => ({ hopUrl, status }))).toEqual([{ hopUrl: `${url}signin`, status: 200 }]);
			expect(signedIn!.text.toString()).toContain("Signed in");
			// Closing the sign-in tab returns to the document's tab, whose page is the same document.
			expect(backToDocument!.navigationHops.map(({ url: hopUrl, contentCaptured }) => ({ hopUrl, contentCaptured }))).toEqual([{ hopUrl: `${url}document`, contentCaptured: true }]);

			// The file its link opened in another tab was taken there, never saved.
			expect(recording.downloads).toEqual([expect.objectContaining({ url: `${url}Invoice-4711.zip`, fileName: "Invoice-4711.zip", bytes: ZIP })]);
			// The network record holds every tab's requests from its first one: the document's
			// redirect, and the sign-in that carried the synthetic password.
			expect(recording.requests.map((request) => `${request.method} ${request.url}`)).toEqual(expect.arrayContaining([`GET ${url}d/abc`, `GET ${url}document`, `GET ${url}viewer.js`, `GET ${url}signin`, `POST ${url}collect`]));
			expect(new URLSearchParams(posts[0]).get("password")).toBe(canaries.password);
			expect(new URLSearchParams(recording.requests.find((request) => request.method === "POST")?.postData).get("password")).toBe(canaries.password);

			// The new tab is the visit's Windows desktop from its first request and its first script, never Linux Chromium.
			expect(seenAs).toEqual([expect.stringMatching(/^header: Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\)/), "script: Win32 1920x1080"]);
			// The live view shows the tab the agent is on.
			expect(live.some((event) => event.type === "browser.frame" && event.url === `${url}signin`)).toBeTrue();
			expect(live).toContainEqual({ type: "browser.download", fileName: "Invoice-4711.zip", url: `${url}Invoice-4711.zip` });
		} finally {
			await archive.session?.close();
			server.stop(true);
		}
	}, 90_000);

	test("a walk that ends right after opening a tab ends on that tab: its page is the visit's last step", async () => {
		const { server, url } = serveNewTabKit();
		const model = new ScriptedModel([
			(page) => ({ calls: [{ name: "click", arguments: { ref: refIn(page, 'link "Open document"') } }] }),
			// Done the moment the tab is shown: no quiet period passes on it before the walk ends.
			() => ({ calls: [{ name: "done", arguments: { result: { submissionsAttempted: 0, downloadsStarted: 0, asksForPhone: false, blockedByChallenge: false, stoppedReason: "Opened the document." }, summary: "Done." } }] }),
		]);
		const archive = await archiveWebsite({ url, keepSession: true }, { ...fast, getBrowser: launch });
		try {
			const recording = await archive.session!.visit({ canaries: createExfiltrationCanaries(), agent: taskAgentVisit(() => model) });
			expect(recording.agent).toMatchObject({ outcome: "completed" });
			expect(recording.steps.map(({ step }) => step.url)).toEqual([`${url}document`]);
			expect(recording.steps[0]!.step.text.toString()).toContain("Invoice 4711");
		} finally {
			await archive.session?.close();
			server.stop(true);
		}
	}, 60_000);

	test("a model that fails ends the walk as failed, with the reason redacted; a walk past the budget is timed out", async () => {
		const { server, url } = serveKit();
		const canaries = createExfiltrationCanaries();
		const archive = await archiveWebsite({ url, keepSession: true }, { ...fast, getBrowser: launch });
		try {
			const failed = await archive.session!.visit({ canaries, agent: taskAgentVisit(() => new FailingModel()) });
			expect(failed.agent.outcome).toBe("failed");
			expect(failed.agent.failure).toStartWith("failed: Error: model answered HTTP 401: invalid api_key=[redacted]");
			expect(failed.steps).toEqual([]);
		} finally {
			await archive.session?.close();
		}
		const second = await archiveWebsite({ url, keepSession: true }, { ...fast, visitBudgetMs: 2_500, getBrowser: launch });
		try {
			const started = Date.now();
			const timedOut = await second.session!.visit({ canaries, agent: taskAgentVisit(() => new StalledModel()) });
			expect(timedOut.agent).toMatchObject({ outcome: "timed_out", failure: "The visit's 0-minute budget ended the walk." });
			expect(Date.now() - started).toBeLessThan(10_000);
		} finally {
			await second.session?.close();
			server.stop(true);
		}
	}, 60_000);

	// Three walks on one capture session: the agent continues in the captured tab and never closes it.
	test("an agent that stops the walk itself, or asks for something it cannot give, has finished the visit with its reason", async () => {
		const { server, url } = serveKit();
		const canaries = createExfiltrationCanaries();
		const archive = await archiveWebsite({ url, keepSession: true }, { ...fast, getBrowser: launch });
		try {
			const gaveUp = await archive.session!.visit({ canaries, agent: taskAgentVisit(() => new ScriptedModel([() => ({ calls: [{ name: "fail", arguments: { reason: "The form rejected the password three times." } }] })])) });
			expect(gaveUp.agent).toMatchObject({ outcome: "completed", report: { submissionsAttempted: 0, downloadsStarted: 0, asksForPhone: false, stoppedReason: "The form rejected the password three times." } });
			const asks = await archive.session!.visit({ canaries, agent: taskAgentVisit(() => new ScriptedModel([() => ({ calls: [{ name: "needs_input", arguments: { question: "The site wants a code sent to a real phone." } }] })])) });
			expect(asks.agent).toMatchObject({ outcome: "completed", report: { stoppedReason: "The site wants a code sent to a real phone." } });
			const scroll: ScriptedTurn = () => ({ calls: [{ name: "scroll", arguments: { direction: "down" } }] });
			process.env.SITE_VISIT_TASK_MAX_STEPS = "2";
			try {
				const looping = await archive.session!.visit({ canaries, agent: taskAgentVisit(() => new ScriptedModel([scroll, scroll])) });
				expect(looping.agent).toMatchObject({ outcome: "failed", failure: "step_limit: Stopped after 2 steps without finishing." });
			} finally {
				delete process.env.SITE_VISIT_TASK_MAX_STEPS;
			}
		} finally {
			await archive.session?.close();
			server.stop(true);
		}
	}, 60_000);

	test("an agent that cannot start is a failed walk, not a broken visit", async () => {
		const { server, url } = serveKit();
		const canaries = createExfiltrationCanaries();
		const agent: VisitAgent = async () => { throw new Error("no CDP connection is free"); };
		const archive = await archiveWebsite({ url, keepSession: true }, { ...fast, getBrowser: launch });
		try {
			expect((await archive.session!.visit({ canaries, agent })).agent).toMatchObject({ outcome: "failed", failure: "no CDP connection is free" });
		} finally {
			await archive.session?.close();
			server.stop(true);
		}
	}, 60_000);
});

describe.skipIf(!chromiumAvailable)("the capture's browser around a visit, in a real browser", () => {
	test("a capture made without keepSession closes its browser; a closed session cannot be visited", async () => {
		const { server, url } = serveKit();
		try {
			const browsers: Array<{ connected: boolean }> = [];
			const plain = await archiveWebsite({ url }, { ...fast, getBrowser: async () => { const browser = await launch(); browsers.push(browser); return browser; } });
			expect(plain.session).toBeUndefined();
			expect(browsers.map((browser) => browser.connected)).toEqual([false]);

			const kept = await archiveWebsite({ url, keepSession: true }, { ...fast, getBrowser: launch });
			await kept.session!.close();
			await kept.session!.close();
			await expect(kept.session!.visit({ canaries: createExfiltrationCanaries(), agent: taskAgentVisit(() => new ScriptedModel([])) })).rejects.toThrow("The capture's browser is already closed.");
		} finally {
			server.stop(true);
		}
	}, 60_000);
});

describe("the agent's steps in the live log", () => {
	test("are the model's thought, then each action's outcome with its element, value and time, bounded; a step without a thought has only its actions", () => {
		const usage = { inputTokens: 0, outputTokens: 0 };
		const at = "2026-11-17T10:00:01.000Z";
		expect(stepActions({
			step: 3, url: "https://kit.example/", title: "Kit", durationMs: 1, usage,
			thought: "  Submit\nthe   form. ",
			actions: [
				{ tool: "type", args: { ref: "e1", text: "{{secret:password}}" }, ok: true, output: "typed into e1; its value is now \"(password entered)\"" },
				{ tool: "click", args: { ref: "e2" }, ok: true, output: "clicked e2; the page navigated\nmore" },
				{ tool: "wait", args: {}, ok: true, output: "" },
				{ tool: "select", args: { ref: "e3", values: ["Deutschland", "DE"] }, ok: true, output: "selected \"Deutschland\" in e3" },
				{ tool: "select", args: { ref: "e4", value: "+49" }, ok: true, output: "selected \"+49\" in e4" },
			],
		}, at)).toEqual([
			{ id: "3", kind: "thought", text: "Submit the form.", at },
			{ id: "3.1", kind: "type", text: "typed into e1; its value is now \"(password entered)\"", selector: "e1", value: "{{secret:password}}", at },
			{ id: "3.2", kind: "click", text: "clicked e2; the page navigated", selector: "e2", at },
			{ id: "3.3", kind: "wait", text: "wait", at },
			{ id: "3.4", kind: "select", text: "selected \"Deutschland\" in e3", selector: "e3", value: "Deutschland, DE", at },
			{ id: "3.5", kind: "select", text: "selected \"+49\" in e4", selector: "e4", value: "+49", at },
		]);
		expect(stepActions({ step: 1, url: "", title: "", durationMs: 0, usage, thought: "", actions: [{ tool: "click", args: { text: "y".repeat(3_000) }, ok: false, output: "x".repeat(500) }] }, at))
			.toEqual([{ id: "1.1", kind: "click", text: "x".repeat(300), value: "y".repeat(2_000), at }]);
	});
});
