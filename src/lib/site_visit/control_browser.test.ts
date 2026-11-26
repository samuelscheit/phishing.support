import { describe, expect, test } from "bun:test";

import { createExfiltrationCanaries } from "../exfiltration/canaries";
import { archiveWebsite } from "../website/archive";
import { chromiumAvailable, html, launchTestChromium, ScriptedModel } from "../browser/task/test_helpers";
import { taskAgentVisit } from "./agent";
import { closeVisitControl, openVisitControl, viewerLabel, type VisitControl, type VisitControlEvent } from "./control";
import { describeElementAt, describeFocusedElement } from "./live_input";
import type { LiveFrame } from "./screen";
import type { SiteVisitLiveEvent } from "./visit";
import { sleep } from "../util/sleep";

const fast = { scriptNavigationSettleMs: 20, renderSettleMs: 800, visitPollMs: 150, visitStepQuietMs: 400 } as const;
const VIEWER = "viewer-e2e-0000000000";

/** A kit whose sign-in sits at fixed places on the page, so a test can click it like a person would. */
function serveSignIn() {
	const posts: string[] = [];
	const at = (top: number) => `position:absolute;left:20px;top:${top}px;width:200px;height:30px`;
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const { pathname } = new URL(request.url);
			if (pathname === "/collect" && request.method === "POST") {
				posts.push(await request.text());
				return Response.redirect("/inbox", 302);
			}
			if (pathname === "/inbox") return html("<h1>Inbox of the kit</h1><p>Confirm your card to continue.</p>", "Inbox");
			return html(`<form method="POST" action="/collect">
<input id="user" name="username" placeholder="Username" style="${at(20)}">
<input id="pass" type="password" name="password" placeholder="Password" style="${at(70)}">
<button style="${at(120)}">Sign in</button></form>`, "Sign in");
		},
	});
	return { server, posts, url: `http://127.0.0.1:${server.port}/` };
}

async function until(condition: () => boolean, what: string, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}

const key = (letter: string) => [
	{ type: "key" as const, phase: "down" as const, key: letter, code: `Key${letter.toUpperCase()}`, keyCode: letter.toUpperCase().charCodeAt(0), modifiers: 0 },
	{ type: "key" as const, phase: "up" as const, key: letter, code: `Key${letter.toUpperCase()}`, keyCode: letter.toUpperCase().charCodeAt(0), modifiers: 0 },
];
const click = (x: number, y: number) => [
	{ type: "pointer" as const, phase: "down" as const, x, y, button: "left" as const, clickCount: 1 },
	{ type: "pointer" as const, phase: "up" as const, x, y, button: "left" as const, clickCount: 1 },
];

describe.skipIf(!chromiumAvailable)("a person driving a live visit, in a real browser", () => {
	test("takes over mid-walk, signs in by hand past the visit's budget, records the page and hands back; the agent finishes with their account, and everything is recorded", async () => {
		const { server, posts, url } = serveSignIn();
		const canaries = createExfiltrationCanaries();
		const live: SiteVisitLiveEvent[] = [];
		const control: VisitControl = openVisitControl("e2e-takeover", (event) => live.push(event));
		let token = "";
		const model = new ScriptedModel([
			// The person takes over while the agent is still thinking about the sign-in.
			async (_page, request) => {
				token = (control.take(VIEWER) as { token: string }).token;
				// The model call was dropped the moment the person took over.
				expect(request.signal?.aborted).toBe(true);
				throw request.signal!.reason;
			},
			(page) => {
				expect(page).toContain("Inbox of the kit");
				return { calls: [{ name: "done", arguments: { result: { asksForPhone: false, blockedByChallenge: false, stoppedReason: "A person signed in; the kit asks for a card." }, summary: "Done." } }] };
			},
		]);
		// A budget shorter than the person's turn: it does not run while they drive.
		const archive = await archiveWebsite({ url, keepSession: true }, { ...fast, visitBudgetMs: 4_000, getBrowser: () => launchTestChromium() });
		try {
			const visiting = archive.session!.visit({ canaries, agent: taskAgentVisit(() => model), live: (event) => live.push(event), control });
			await until(() => control.mode === "human", "the agent to pause");

			// The sharp screen shows the page at its CSS size, which input coordinates are in.
			const frames: LiveFrame[] = [];
			const stopWatching = control.screen.watch((frame) => frames.push(frame), "high");
			await until(() => frames.length > 0, "a frame");
			const [frame] = frames;
			expect(frame!.url).toBe(url);
			expect(frame!.width).toBeGreaterThan(400);
			expect(frame!.height).toBeGreaterThan(300);
			expect(Buffer.from(frame!.jpeg, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

			expect(await control.input(VIEWER, token, [...click(40, 35), ...key("a"), ...key("l"), ...key("i"), ...key("x")])).toEqual({ ok: true });
			expect(await control.input(VIEWER, token, [
				{ type: "key", phase: "down", key: "Backspace", code: "Backspace", keyCode: 8, modifiers: 0 },
				{ type: "text", text: "ce" },
				...click(40, 85),
				{ type: "fake", field: "password" },
				...click(60, 135),
			])).toEqual({ ok: true });
			await until(() => posts.length === 1, "the sign-in to be posted");
			await sleep(4_500);
			expect(await control.input(VIEWER, token, [{ type: "capture" }])).toEqual({ ok: true });
			expect(await control.release(VIEWER, token, "signed in, the card step is next")).toEqual({ ok: true });
			stopWatching();

			const recording = await visiting;
			// The budget would have ended the visit during the person's turn; it did not run then.
			expect(recording.agent).toMatchObject({ outcome: "completed", report: { stoppedReason: "A person signed in; the kit asks for a card." } });

			// What the person typed reached the kit, the made-up password as its real synthetic value.
			const form = new URLSearchParams(posts[0]);
			expect(form.get("username")).toBe("alice");
			expect(form.get("password")).toBe(canaries.password);
			const sent = recording.requests.find((request) => request.method === "POST" && request.url === `${url}collect`);
			expect(new URLSearchParams(sent?.postData).get("password")).toBe(canaries.password);
			expect(recording.steps.map(({ step }) => step.url)).toContain(`${url}inbox`);

			// Every action is in the record, the person's marked as theirs, with the fields they went into.
			const human = recording.agent.actions.filter((action) => action.actor === "human");
			expect(human.map((action) => [action.kind, action.selector ?? "", action.value ?? ""])).toEqual([
				["takeover", "", ""],
				["click", 'input#user[name=username] "Username"', ""],
				["type", 'input#user[name=username] "Username"', "alice"],
				["click", 'input#pass[name=password][type=password] "Password"', ""],
				["type", 'input#pass[name=password][type=password] "Password"', canaries.password],
				["click", 'button "Sign in"', ""],
				["capture", "", ""],
				["handback", "", "signed in, the card step is next"],
			]);
			expect(human[4]!.typedAs).toBe("made-up password");
			expect(recording.agent.actions.filter((action) => action.actor === "agent").map((action) => action.kind)).toEqual(["done"]);

			// The agent was told what the person did, where the tab is, and their note.
			const seen = model.seen();
			expect(seen).toContain("A person took over the browser for");
			expect(seen).toContain('Typed into input#user[name=username] "Username" (typed "alice")');
			expect(seen).toContain(`The visitor's tab now shows ${url}inbox.`);
			expect(seen).toContain("They add: signed in, the card step is next");

			// Viewers saw who drove, and every action live; frames never went through the event log.
			const modes = live.filter((event): event is VisitControlEvent => event.type === "browser.control").map((event) => event.mode);
			expect(modes.filter((mode, index) => mode !== modes[index - 1])).toEqual(["agent", "pausing", "human", "agent", "ended"]);
			expect(live.find((event) => event.type === "browser.control" && event.mode === "human")).toMatchObject({ controller: viewerLabel(VIEWER), fakeValues: { email: canaries.email, password: canaries.password } });
			expect(live.filter((event) => event.type === "browser.action" && event.actor === "human")).toHaveLength(8);
			expect(JSON.stringify(live)).not.toContain("jpeg");
		} finally {
			await closeVisitControl(control);
			await archive.session?.close();
			server.stop(true);
		}
	}, 60_000);

	test("elements are described from the browser's DOM agent: under a point, and the focused field", async () => {
		const browser = await launchTestChromium();
		try {
			const page = await browser.newPage();
			await page.setContent(`<input id="mail" name="email" type="email" aria-label="Email address" style="position:absolute;left:0;top:0;width:100px;height:20px">
<button style="position:absolute;left:0;top:40px;width:100px;height:20px">  Continue
 to inbox </button><div style="position:absolute;left:0;top:80px;width:100px;height:20px;pointer-events:none">overlay</div>`);
			const session = await page.target().createCDPSession();
			expect(await describeElementAt(session, 10, 10)).toBe('input#mail[name=email][type=email] "Email address"');
			expect(await describeElementAt(session, 10, 50)).toBe('button "Continue to inbox"');
			expect(await describeFocusedElement(session)).toBeUndefined();
			await page.focus("#mail");
			expect(await describeFocusedElement(session)).toBe('input#mail[name=email][type=email] "Email address"');
			// A page that redefines its own DOM API does not change what the record says.
			await page.evaluate(() => {
				Object.defineProperty(Document.prototype, "elementFromPoint", { value: () => null });
			});
			expect(await describeElementAt(session, 10, 10)).toBe('input#mail[name=email][type=email] "Email address"');
		} finally {
			await browser.close();
		}
	}, 30_000);
});
