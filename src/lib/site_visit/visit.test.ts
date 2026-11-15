import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import puppeteer, { type Page } from "rebrowser-puppeteer-core";

import { createExfiltrationCanaries } from "../exfiltration/canaries";
import type { ExfiltrationCanaries } from "../exfiltration/types";
import { archiveWebsite } from "../website_archive";
import { skyvernVisitAgent, taskActions, timelineActions, type VisitAgent, type VisitAgentAction } from "./agent";
import type { SiteVisitLiveEvent } from "./visit";

const chromiumExecutable = process.env.PHISHING_TEST_CHROMIUM
	?? `${homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const chromiumAvailable = await Bun.file(chromiumExecutable).exists();
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
 * Drives the page the way Skyvern does: over its own connection to the
 * browser, on the tab that is already open, with the synthetic values.
 */
function scriptedAgent(walk: (page: Page, canaries: ExfiltrationCanaries) => Promise<void>, canaries: ExfiltrationCanaries, options: { fail?: string; neverEnds?: boolean } = {}) {
	const tasks: Array<{ url: string; prompt: string; address: string }> = [];
	let done: Promise<unknown> = Promise.resolve();
	let finished = false;
	const actions: VisitAgentAction[] = [];
	const agent: VisitAgent = {
		start: async (task, address) => {
			tasks.push({ url: task.url, prompt: task.prompt, address });
			done = (async () => {
				const connection = await puppeteer.connect({ browserWSEndpoint: address });
				try {
					const [page] = await connection.pages();
					await walk(page!, canaries);
					actions.push({ id: "a1", kind: "click", text: "Submitted the sign-in form with the synthetic values" });
					// A Task V3 action has no text of its own, only the element it acted on.
					actions.push({ id: "a2", kind: "click", text: "Clicked", selector: "#open" });
				} finally {
					await connection.disconnect();
					finished = !options.neverEnds;
				}
			})();
			return { runId: "tsk_v2_test" };
		},
		state: async () => {
			if (!finished) return { state: "running" };
			await done;
			return options.fail ? { state: "failed", reason: options.fail } : { state: "completed", output: { submissionsAttempted: 1, downloadsStarted: 1, asksForPhone: false, stoppedReason: "Downloaded the verifier." } };
		},
		actions: async () => [...actions],
		cancel: async () => { finished = true; },
	};
	return { agent, tasks };
}

async function signInAndDownload(page: Page, canaries: ExfiltrationCanaries) {
	await page.type("input[name=username]", canaries.email);
	await page.type("input[name=password]", canaries.password);
	await Promise.all([page.waitForNavigation(), page.click("button")]);
	await new Promise((resolve) => setTimeout(resolve, 900));
	await page.click("#open");
	await new Promise((resolve) => setTimeout(resolve, 300));
	await page.click("#dl");
	await new Promise((resolve) => setTimeout(resolve, 900));
}

describe.skipIf(!chromiumAvailable)("a site visit, in a real browser", () => {
	test("records each page the agent reaches, where the synthetic values went, and the file it downloaded, live", async () => {
		const { server, posts, url } = serveKit();
		const canaries = createExfiltrationCanaries();
		const { agent, tasks } = scriptedAgent(signInAndDownload, canaries);
		const live: SiteVisitLiveEvent[] = [];
		const archive = await archiveWebsite({ url, keepSession: true }, { ...fast, getBrowser: launch });
		try {
			const recording = await archive.session!.visit({ canaries, agent, live: (event) => live.push(event) });

			// The agent was started on the captured tab, with the synthetic values.
			expect(tasks).toHaveLength(1);
			expect(tasks[0]!.url).toBe(url);
			expect(tasks[0]!.prompt).toContain(canaries.password);
			expect(recording.agent).toMatchObject({ runId: "tsk_v2_test", outcome: "completed", report: { submissionsAttempted: 1, stoppedReason: "Downloaded the verifier." } });

			// The sign-in was submitted to the kit's collector, and the network recording shows it.
			expect(posts).toHaveLength(1);
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
			expect(live).toContainEqual({ type: "browser.action", kind: "click", text: "Submitted the sign-in form with the synthetic values" });
			// The visit reads the element's caption in the live page.
			expect(recording.agent.actions).toContainEqual({ id: "a2", kind: "click", text: 'Clicked "Get Verifier"', selector: "#open" });
		} finally {
			await archive.session?.close();
			server.stop(true);
		}
	}, 60_000);

	test("an agent that fails or runs past the budget ends the walk with what was recorded", async () => {
		const { server, url } = serveKit();
		const canaries = createExfiltrationCanaries();
		const failing = scriptedAgent(async () => undefined, canaries, { fail: "failed: Skyvern could not reach its model" });
		const late = scriptedAgent(async (page) => { await page.type("input[name=username]", canaries.email); }, canaries, { neverEnds: true });
		const archive = await archiveWebsite({ url, keepSession: true }, { ...fast, getBrowser: launch });
		try {
			const failed = await archive.session!.visit({ canaries, agent: failing.agent });
			expect(failed.agent).toMatchObject({ outcome: "failed", failure: "failed: Skyvern could not reach its model" });
			expect(failed.steps).toEqual([]);
		} finally {
			await archive.session?.close();
		}
		const second = await archiveWebsite({ url, keepSession: true }, { ...fast, visitBudgetMs: 2_500, getBrowser: launch });
		try {
			const timedOut = await second.session!.visit({ canaries, agent: late.agent });
			expect(timedOut.agent).toMatchObject({ outcome: "timed_out", failure: "The visit's 0-minute budget ended the walk." });
		} finally {
			await second.session?.close();
			server.stop(true);
		}
	}, 60_000);

	test("an agent that cannot start is a failed walk, not a broken visit", async () => {
		const { server, url } = serveKit();
		const canaries = createExfiltrationCanaries();
		const agent: VisitAgent = { start: async () => { throw new Error("Skyvern answered HTTP 503"); }, state: async () => ({ state: "running" }), actions: async () => [], cancel: async () => undefined };
		const archive = await archiveWebsite({ url, keepSession: true }, { ...fast, getBrowser: launch });
		try {
			expect((await archive.session!.visit({ canaries, agent })).agent).toMatchObject({ outcome: "failed", failure: "The visiting agent could not start: Skyvern answered HTTP 503" });
		} finally {
			await archive.session?.close();
			server.stop(true);
		}
	}, 60_000);
});

describe("the agent's timeline", () => {
	test("lists its actions and thoughts once each, oldest first", () => {
		const timeline = [
			{ type: "thought", thought: { thought_id: "ot_2", thought: "The page shows a sign-in form.", thought_type: "plan", created_at: "2026-11-14T23:41:02" }, children: [] },
			{ type: "block", block: { actions: [
				{ action_id: "a_1", action_type: "input_text", intention: "Enter the synthetic email into Username", created_at: "2026-11-14T23:41:05" },
				{ action_id: "a_2", action_type: "click", reasoning: "Submit the form", created_at: "2026-11-14T23:41:07" },
			] }, children: [{ type: "thought", thought: { thought_id: "ot_2", thought: "duplicate" } }] },
			{ type: "thought", thought: { thought_id: "ot_1", thought: "Open the page.", thought_type: "plan", created_at: "2026-11-14T23:40:58" } },
		];
		expect(timelineActions(timeline)).toEqual([
			{ id: "ot_1", kind: "plan", text: "Open the page." },
			{ id: "ot_2", kind: "plan", text: "The page shows a sign-in form." },
			{ id: "a_1", kind: "input_text", text: "Enter the synthetic email into Username" },
			{ id: "a_2", kind: "click", text: "Submit the form" },
		]);
	});
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
			const { agent } = scriptedAgent(async () => undefined, createExfiltrationCanaries());
			await expect(kept.session!.visit({ canaries: createExfiltrationCanaries(), agent })).rejects.toThrow("The capture's browser is already closed.");
		} finally {
			server.stop(true);
		}
	}, 60_000);
});

describe("the agent's task actions (Task V1 and V3)", () => {
	test("are read as a verb and the element they acted on; actions without an id or type are dropped", () => {
		expect(taskActions([
			{ action_id: "act_1", action_type: "click", element_id: "[data-tv3=\"t0\"]", reasoning: null, intention: null },
			{ action_id: "act_2", action_type: "input_text", element_id: "#phone-input" },
			{ action_id: "act_3", action_type: "complete" },
			{ action_type: "click" },
			null,
		])).toEqual([
			{ id: "act_1", kind: "click", text: "Clicked", selector: "[data-tv3=\"t0\"]" },
			{ id: "act_2", kind: "input_text", text: "Typed into", selector: "#phone-input" },
			{ id: "act_3", kind: "complete", text: "Finished" },
		]);
	});

	test("a Task V2 run is read from its timeline; a Task V3 run, which has none, from its actions", async () => {
		const calls: string[] = [];
		const agent = skyvernVisitAgent(() => ({
			createTask: async () => ({ runId: "x", response: {} }),
			getRun: async () => ({}),
			cancelRun: async () => undefined,
			getRunTimeline: async (runId: string) => { calls.push(`timeline ${runId}`); return [{ thought: { thought_id: "ot_1", thought: "Plan." } }]; },
			getTaskActions: async (runId: string) => { calls.push(`actions ${runId}`); return [{ action_id: "act_1", action_type: "click", element_id: "#dlConfirm" }]; },
		}));
		expect(await agent.actions("tsk_v2_597084519460743340")).toEqual([{ id: "ot_1", kind: "thought", text: "Plan." }]);
		expect(await agent.actions("tsk_597175287129714516")).toEqual([{ id: "act_1", kind: "click", text: "Clicked", selector: "#dlConfirm" }]);
		expect(calls).toEqual(["timeline tsk_v2_597084519460743340", "actions tsk_597175287129714516"]);
	});
});
