import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

import type { VisitorTabs } from "@/lib/browser/visitor_tabs";
import { createExfiltrationCanaries } from "@/lib/exfiltration/canaries";
import { closeVisitControl, openVisitControl, viewerLabel, type VisitControl } from "./control";
import { decodeFrame, liveSocketPath, MAX_CLIENT_MESSAGE, type FrameMeta, type ScreenQuality, type ServerMessage } from "./live_protocol";
import { serveLiveSocket } from "./live_socket";
import type { ScreenTab } from "./screen";
import { syntheticVisitValues } from "./visit_task";

const ALICE = "alice-socket-0000000000";
const BOB = "bob-socket-000000000000";

/** A live control on a fake visit: the test plays screencast frames on its tab and reads what reached the tab. */
function liveVisit() {
	const id = `live-socket-${Math.random()}`;
	const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
	const session = Object.assign(new EventEmitter(), {
		send: async (method: string, params?: Record<string, unknown>) => {
			sent.push({ method, params });
			return method === "Page.getLayoutMetrics" ? { cssVisualViewport: { pageX: 0, pageY: 0 } } : {};
		},
	});
	const page = { url: () => "https://kit.example/login", title: async () => "Sign in", reload: async () => sent.push({ method: "page.reload" }) };
	const tab = { targetId: "T1", session, page, closed: false };
	const control = openVisitControl(id, () => undefined);
	control.attach({
		tabs: { first: tab, active: () => tab, tabs: () => [tab] } as unknown as VisitorTabs,
		touch: false,
		values: syntheticVisitValues(createExfiltrationCanaries()),
		recordStep: async () => true,
		onAction: () => undefined,
		onDriving: () => undefined,
	});
	let frameId = 0;
	const frame = (jpeg: string) => session.emit("Page.screencastFrame", { data: Buffer.from(jpeg).toString("base64"), sessionId: ++frameId, metadata: { deviceWidth: 393, deviceHeight: 852 } });
	return { id, control, frame, sent };
}

/** A browser tab of one exit while the site loads; the test plays its screencast. */
function exitTab(id: string, url: string) {
	const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
	const session = Object.assign(new EventEmitter(), {
		id: () => id,
		send: async (method: string, params?: Record<string, unknown>) => {
			sent.push({ method, params });
			return method === "Page.getLayoutMetrics" ? { cssVisualViewport: { pageX: 0, pageY: 0 } } : {};
		},
	});
	const page = { url: () => url, title: async () => "Sign in" };
	let frameId = 0;
	return {
		tab: { session, page } as unknown as ScreenTab,
		session,
		page,
		sent,
		frame: (jpeg: string) => session.emit("Page.screencastFrame", { data: Buffer.from(jpeg).toString("base64"), sessionId: ++frameId, metadata: { deviceWidth: 1280, deviceHeight: 800 } }),
	};
}

/** The agent reaches its checkpoint: a person who took over drives from now on. */
function agentPauses(control: VisitControl) {
	void control.steering.checkpoint(new AbortController().signal);
}

let server: Server;
let origin: string;

beforeAll(async () => {
	// As the app serves it: next-ws upgrades into a server capped like the one `instrumentation.ts` sets up.
	const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE });
	server = createServer();
	server.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url!, "http://localhost");
		const key = decodeURIComponent(url.pathname.split("/")[3]!);
		sockets.handleUpgrade(request, socket, head, (client) => serveLiveSocket(client, key, url.searchParams));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
	server.close();
});

type Frame = { meta: FrameMeta; jpeg: string };

/** A viewer's socket, with everything it heard. */
async function connect(id: string, viewer: string, quality: ScreenQuality = "low") {
	const socket = new WebSocket(`${origin}${liveSocketPath(id, viewer, quality)}`);
	socket.binaryType = "arraybuffer";
	const messages: ServerMessage[] = [];
	const frames: Frame[] = [];
	const waiters = new Set<() => void>();
	const closed = new Promise<{ code: number; reason: string }>((resolve) => socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason })));
	socket.addEventListener("message", (event) => {
		if (typeof event.data === "string") messages.push(JSON.parse(event.data) as ServerMessage);
		else {
			const decoded = decodeFrame(event.data as ArrayBuffer)!;
			frames.push({ meta: decoded.meta, jpeg: Buffer.from(decoded.jpeg).toString() });
		}
		for (const waiter of waiters) waiter();
	});
	const until = async <T>(find: () => T | undefined, what: string): Promise<T> => {
		const deadline = Date.now() + 3_000;
		for (;;) {
			const found = find();
			if (found !== undefined) return found;
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; heard ${JSON.stringify(messages)}`);
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 50);
				waiters.add(() => {
					clearTimeout(timer);
					resolve();
				});
			});
			waiters.clear();
		}
	};
	let nextId = 0;
	const opened = new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));
	return {
		socket,
		messages,
		frames,
		closed,
		opened,
		until,
		send: (message: unknown) => socket.send(typeof message === "string" ? message : JSON.stringify(message)),
		/** A command, and the reply to it. */
		command: async (message: Record<string, unknown>) => {
			const id = nextId++;
			socket.send(JSON.stringify({ ...message, id }));
			return until(() => messages.find((candidate) => candidate.type === "reply" && candidate.id === id), `the reply to ${message.type}`);
		},
		/** The newest control state, once one matches. */
		state: (match: (state: Extract<ServerMessage, { type: "browser.control" }>) => boolean, what: string) =>
			until(() => {
				const last = messages.findLast((candidate) => candidate.type === "browser.control") as Extract<ServerMessage, { type: "browser.control" }> | undefined;
				return last && match(last) ? last : undefined;
			}, what),
	};
}

describe("a viewer's socket to a live visit", () => {
	test("a visit that is not live is over at once; a viewer without an id is turned away", async () => {
		const missing = await connect(`live-socket-none-${Math.random()}`, ALICE);
		expect(await missing.closed).toEqual({ code: 1000, reason: "The visit is not live." });
		expect(missing.messages).toEqual([{ type: "end" }]);

		const { id, control } = liveVisit();
		try {
			const anonymous = await connect(id, "short");
			expect((await anonymous.closed).code).toBe(1008);
		} finally {
			await closeVisitControl(control);
		}
	});

	test("hears the control state on connect, then the screen as binary frames with their page size", async () => {
		const { id, control, frame } = liveVisit();
		try {
			const viewer = await connect(id, ALICE);
			const state = await viewer.state(() => true, "the control state");
			expect(state).toMatchObject({ type: "browser.control", mode: "agent", you: false, agentRunning: true });
			// The screen started for the viewer; its first frame arrives.
			await viewer.until(() => (control.screen.viewers === 1 ? true : undefined), "the viewer to watch");
			await new Promise((resolve) => setTimeout(resolve, 10));
			frame("\xff\xd8 first");
			const [first] = await viewer.until(() => (viewer.frames.length ? viewer.frames : undefined), "a frame");
			expect(first).toEqual({ meta: { url: "https://kit.example/login", width: 393, height: 852 }, jpeg: "\xff\xd8 first" });
		} finally {
			await closeVisitControl(control);
		}
	});

	test("take, drive, write to the agent and hand back; only the driver hears it drives; another viewer is refused", async () => {
		const { id, control, sent } = liveVisit();
		try {
			const alice = await connect(id, ALICE);
			const bob = await connect(id, BOB);
			await Promise.all([alice.opened, bob.opened]);

			expect(await alice.command({ type: "take" })).toEqual({ type: "reply", id: 0, ok: true });
			await alice.state((state) => state.mode === "pausing" && state.you, "Alice to drive");
			const seenByBob = await bob.state((state) => state.mode === "pausing", "Bob to hear of the takeover");
			expect(seenByBob).toMatchObject({ controller: viewerLabel(ALICE), you: false });
			expect(JSON.stringify(bob.messages)).not.toContain(ALICE);
			expect(await bob.command({ type: "take" })).toEqual({ type: "reply", id: 0, ok: false, status: 409, error: `${viewerLabel(ALICE)} is driving the browser.` });
			// Inputs from anyone but the driver are refused, and so are the driver's until the agent let go.
			bob.send({ type: "input", inputs: [{ type: "reload" }] });
			await bob.until(() => bob.messages.find((message) => message.type === "refused"), "Bob's input refused");
			expect(bob.messages.find((message) => message.type === "refused")).toEqual({ type: "refused", status: 403, error: "You are not driving the browser." });

			agentPauses(control);
			await alice.state((state) => state.mode === "human" && state.you, "the browser to be Alice's");
			// Sent one after another without waiting: they reach the tab in order.
			alice.send({ type: "input", inputs: [{ type: "text", text: "ab" }] });
			alice.send({ type: "input", inputs: [{ type: "text", text: "cd" }] });
			alice.send({ type: "input", inputs: [{ type: "key", phase: "down", key: "Enter", code: "Enter", keyCode: 13 }, { type: "key", phase: "up", key: "Enter", code: "Enter", keyCode: 13 }] });
			await alice.until(() => (sent.some((call) => call.method === "Input.dispatchKeyEvent") ? true : undefined), "the key to reach the tab");
			expect(sent.filter((call) => call.method === "Input.insertText").map((call) => call.params?.text)).toEqual(["ab", "cd"]);

			expect(await bob.command({ type: "message", text: "Try the card page next." })).toEqual({ type: "reply", id: 1, ok: true });
			expect(await alice.command({ type: "release", note: "signed in" })).toEqual({ type: "reply", id: 1, ok: true });
			await alice.state((state) => state.mode === "agent" && !state.you, "the agent to drive again");
			expect(alice.messages.some((message) => message.type === "refused")).toBe(false);
		} finally {
			await closeVisitControl(control);
		}
	});

	test("a viewer of a loading visit watches each exit's browser and the agent's visit on one connection, refused control until the agent walks", async () => {
		const id = `live-socket-loading-${Math.random()}`;
		const control = openVisitControl(id, () => undefined, { mode: "loading", status: "Starting browser via residential exit…" });
		try {
			const viewer = await connect(id, ALICE);
			expect(await viewer.state(() => true, "the loading state")).toMatchObject({ mode: "loading", status: "Starting browser via residential exit…", agentRunning: false, you: false, tabs: [] });
			await viewer.until(() => (control.screen.viewers === 1 ? true : undefined), "the viewer to watch");
			expect(await viewer.command({ type: "take" })).toEqual({ type: "reply", id: 0, ok: false, status: 409, error: "The site is still loading; take over unlocks once the agent starts." });
			expect(await viewer.command({ type: "message", text: "hello" })).toEqual({ type: "reply", id: 1, ok: false, status: 409, error: "The agent has not started walking the site yet." });

			const residential = exitTab("S1", "https://kit.example/");
			await control.watchTab(residential.tab, "Loading page via residential exit…");
			await viewer.state((state) => state.status === "Loading page via residential exit…", "the residential exit's status");
			residential.frame("residential");
			await viewer.until(() => viewer.frames.find((frame) => frame.jpeg === "residential"), "the residential exit's frame");

			await control.watchTab(undefined, "Residential exit failed (timeout), trying Tor exit…");
			await viewer.state((state) => state.status === "Residential exit failed (timeout), trying Tor exit…" && state.tabs.length === 0, "the switch");
			const tor = exitTab("S2", "https://kit.example/tor");
			await control.watchTab(tor.tab, "Loading page via Tor exit…");
			// Past the low screen's rate (3 frames a second): the frame goes out at once.
			await new Promise((resolve) => setTimeout(resolve, 400));
			tor.frame("tor");
			const torFrame = await viewer.until(() => viewer.frames.find((frame) => frame.jpeg === "tor"), "the Tor exit's frame");
			expect(torFrame.meta).toEqual({ url: "https://kit.example/tor", width: 1280, height: 800 });

			const visitorTab = { targetId: "T1", session: tor.session, page: tor.page, closed: false };
			control.attach({
				tabs: { first: visitorTab, active: () => visitorTab, tabs: () => [visitorTab] } as unknown as VisitorTabs,
				touch: false,
				values: syntheticVisitValues(createExfiltrationCanaries()),
				recordStep: async () => true,
				onAction: () => undefined,
				onDriving: () => undefined,
			});
			const walking = await viewer.state((state) => state.mode === "agent", "the agent to walk");
			expect(walking).toMatchObject({ agentRunning: true, run: control.state.run });
			expect(walking).not.toHaveProperty("status");
			expect(await viewer.command({ type: "take" })).toEqual({ type: "reply", id: 2, ok: true });
			await viewer.state((state) => state.mode === "pausing" && state.you, "the viewer to take over");
			// One connection throughout, one visit: every state was of the same run.
			const states = viewer.messages.filter((message) => message.type === "browser.control");
			expect(new Set(states.map((state) => state.run)).size).toBe(1);
			expect(viewer.messages.some((message) => message.type === "end")).toBe(false);
			expect(viewer.socket.readyState).toBe(WebSocket.OPEN);
		} finally {
			await closeVisitControl(control);
		}
	});

	test("a loading visit that ends tells its viewers once and closes their sockets", async () => {
		const id = `live-socket-loading-end-${Math.random()}`;
		const control = openVisitControl(id, () => undefined, { mode: "loading" });
		const viewer = await connect(id, ALICE);
		await viewer.state((state) => state.mode === "loading", "the loading state");
		await closeVisitControl(control);
		expect((await viewer.closed).code).toBe(1000);
		expect(viewer.messages.filter((message) => message.type === "end")).toHaveLength(1);
		expect(viewer.messages.filter((message) => message.type === "browser.control" && message.mode === "ended")).toHaveLength(1);
	});

	test("a driver whose connection dropped drives on from a new socket, without taking over again", async () => {
		const { id, control, sent } = liveVisit();
		try {
			const first = await connect(id, ALICE);
			await first.opened;
			await first.command({ type: "take" });
			agentPauses(control);
			first.socket.close();
			await first.closed;

			const again = await connect(id, ALICE);
			expect(await again.state(() => true, "the control state")).toMatchObject({ mode: "human", you: true });
			again.send({ type: "input", inputs: [{ type: "text", text: "on" }] });
			await again.until(() => (sent.some((call) => call.method === "Input.insertText") ? true : undefined), "the text to reach the tab");
		} finally {
			await closeVisitControl(control);
		}
	});

	test("a slow viewer gets the newest frame, not a backlog; asking for the sharp screen restarts the screencast", async () => {
		const { id, control, frame, sent } = liveVisit();
		try {
			const viewer = await connect(id, ALICE);
			await viewer.until(() => (control.screen.viewers === 1 ? true : undefined), "the viewer to watch");
			await new Promise((resolve) => setTimeout(resolve, 10));
			viewer.send({ type: "quality", quality: "high" });
			await viewer.until(() => sent.find((call) => call.method === "Page.startScreencast" && call.params?.maxWidth === 1920), "the sharp screencast");
			expect(control.screen.viewers).toBe(1);
			// A burst of large frames: each is sent once the one before left the server.
			const big = "x".repeat(2_000_000);
			for (let index = 0; index < 20; index += 1) frame(`${index}${big}`);
			const last = await viewer.until(() => viewer.frames.find((candidate) => candidate.jpeg.startsWith("19")), "the newest frame");
			expect(last.jpeg.length).toBe(2_000_002);
			expect(viewer.frames.length).toBeLessThan(20);
		} finally {
			await closeVisitControl(control);
		}
	});

	test("refuses malformed messages, closes on an oversized one, and ends with the visit", async () => {
		const { id, control } = liveVisit();
		const viewer = await connect(id, ALICE);
		await viewer.opened;
		viewer.send("{");
		viewer.send({ type: "message", id: 0, text: "x".repeat(501) });
		viewer.send({ type: "input", inputs: [] });
		await viewer.until(() => (viewer.messages.filter((message) => message.type === "refused").length === 3 ? true : undefined), "three refusals");
		expect(viewer.messages.filter((message) => message.type === "refused")).toEqual(Array(3).fill({ type: "refused", status: 400, error: "Invalid message." }));

		const watching = await connect(id, BOB);
		await watching.opened;
		await closeVisitControl(control);
		expect((await watching.closed).code).toBe(1000);
		expect(watching.messages.at(-1)).toEqual({ type: "end" });
		expect(watching.messages.findLast((message) => message.type === "browser.control")).toMatchObject({ mode: "ended" });
		await viewer.closed;

		const { id: other, control: second } = liveVisit();
		try {
			const flooding = await connect(other, ALICE);
			await flooding.opened;
			flooding.send("x".repeat(MAX_CLIENT_MESSAGE + 1));
			expect((await flooding.closed).code).toBe(1009);
			await flooding.until(() => (second.screen.viewers === 0 ? true : undefined), "the viewer to stop watching");
		} finally {
			await closeVisitControl(second);
		}
	});
});
