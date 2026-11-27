import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { CDPSession, Page } from "rebrowser-puppeteer-core";

import { LiveScreen, type LiveFrame } from "./screen";
import { sleep } from "../util/sleep";

/** The fake frames carry their name as their JPEG bytes. */
const named = (frame: LiveFrame) => Buffer.from(frame.jpeg).toString();

/** A tab whose screencast the test plays frame by frame. */
function fakeTab(url = "https://kit.example/") {
	const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
	const session = Object.assign(new EventEmitter(), {
		sent,
		send: async (method: string, params?: Record<string, unknown>) => {
			sent.push({ method, ...(params ? { params } : {}) });
			return {};
		},
	});
	let frameId = 0;
	return {
		tab: { session: session as unknown as CDPSession, page: { url: () => url } as unknown as Page },
		sent,
		started: () => sent.filter((call) => call.method === "Page.startScreencast").map((call) => call.params),
		running: () => {
			const starts = sent.filter((call) => call.method === "Page.startScreencast").length;
			return starts > sent.filter((call) => call.method === "Page.stopScreencast").length;
		},
		frame: (name = "AAAA") => session.emit("Page.screencastFrame", { data: Buffer.from(name).toString("base64"), sessionId: ++frameId, metadata: { deviceWidth: 1920.4, deviceHeight: 963, offsetTop: 0, pageScaleFactor: 1 } }),
	};
}

const settle = () => sleep(5);

describe("the live screen of a visit", () => {
	test("runs only while someone watches; small for glancing viewers, sharp while anyone watches full screen or a person drives", async () => {
		const screen = new LiveScreen();
		const first = fakeTab();
		await screen.show(first.tab);
		expect(first.running()).toBe(false);

		const stopLow = screen.watch(() => undefined, "low");
		await settle();
		expect(first.started()).toEqual([{ format: "jpeg", quality: 55, maxWidth: 960, maxHeight: 720, everyNthFrame: 2 }]);

		const stopHigh = screen.watch(() => undefined, "high");
		await settle();
		expect(first.started().at(-1)).toEqual({ format: "jpeg", quality: 80, maxWidth: 1920, maxHeight: 2560, everyNthFrame: 1 });
		stopHigh();
		await settle();
		expect(first.started().at(-1)).toMatchObject({ quality: 55 });

		screen.setDriving(true);
		await settle();
		expect(first.started().at(-1)).toMatchObject({ quality: 80 });
		screen.setDriving(false);
		stopLow();
		await settle();
		expect(first.running()).toBe(false);
		expect(first.started()).toHaveLength(4);
	});

	test("a still page (no paint, so no screencast frame) shows a screenshot as its first frame, as large and sharp as the screencast's", async () => {
		const screen = new LiveScreen();
		const still = fakeTab();
		const send = still.tab.session.send.bind(still.tab.session);
		(still.tab.session as unknown as { send: typeof send }).send = (async (method: string, params?: Record<string, unknown>) => {
			await send(method as never, params as never);
			if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 640, clientWidth: 1280, clientHeight: 800 } };
			if (method === "Page.captureScreenshot") return { data: Buffer.from("STILL").toString("base64") };
			return {};
		}) as typeof send;
		await screen.show(still.tab);
		const seen: LiveFrame[] = [];
		screen.watch((frame) => seen.push(frame), "low");
		await sleep(400);
		expect(seen).toEqual([{ jpeg: Buffer.from("STILL"), url: "https://kit.example/", width: 1280, height: 800 }]);
		expect(still.sent.find((call) => call.method === "Page.captureScreenshot")?.params).toEqual({ format: "jpeg", quality: 55, clip: { x: 0, y: 640, width: 1280, height: 800, scale: 0.75 } });

		// A page that paints in time needs none.
		const painting = fakeTab();
		const other = new LiveScreen();
		await other.show(painting.tab);
		other.watch(() => undefined, "low");
		await settle();
		painting.frame("F0");
		await sleep(400);
		expect(painting.sent.some((call) => call.method === "Page.captureScreenshot")).toBe(false);
		await screen.close();
		await other.close();
	});

	test("a tab that refused its screencast once gets it again on the next poll", async () => {
		const screen = new LiveScreen();
		const tab = fakeTab();
		const send = tab.tab.session.send.bind(tab.tab.session);
		let refusals = 1;
		(tab.tab.session as unknown as { send: typeof send }).send = (async (method: string, params?: Record<string, unknown>) => {
			if (method === "Page.startScreencast" && refusals-- > 0) throw new Error("Target is not active");
			return send(method as never, params as never);
		}) as typeof send;
		await screen.show(tab.tab);
		screen.watch(() => undefined, "low");
		await settle();
		expect(tab.running()).toBe(false);
		expect(refusals).toBe(0);
		await screen.show(tab.tab);
		expect(tab.running()).toBe(true);
	});

	test("follows the visitor into another tab: the old screencast stops, the new one starts", async () => {
		const screen = new LiveScreen();
		const first = fakeTab();
		const second = fakeTab("https://kit.example/popup");
		screen.watch(() => undefined, "low");
		await screen.show(first.tab);
		await screen.show(first.tab);
		expect(first.started()).toHaveLength(1);
		await screen.show(second.tab);
		expect(first.running()).toBe(false);
		expect(second.running()).toBe(true);
	});

	test("cleared between two browsers (an exit failed, the next starts): the screencast stops, viewers stay, nothing stale is shown, the next tab streams at once", async () => {
		const screen = new LiveScreen();
		const failed = fakeTab();
		const next = fakeTab("https://kit.example/next");
		const seen: LiveFrame[] = [];
		screen.watch((frame) => seen.push(frame), "low");
		await screen.show(failed.tab);
		failed.frame("F0");
		// Skipped for the viewer's rate: it must not arrive once the tab is gone.
		failed.frame("F1");
		const clearing = screen.clear();
		// A frame the tab sends before its screencast stopped is acknowledged and dropped.
		failed.frame("F2");
		await clearing;
		expect(failed.running()).toBe(false);
		expect(screen.viewers).toBe(1);
		failed.frame("F3");
		expect(failed.sent.filter((call) => call.method === "Page.screencastFrameAck")).toHaveLength(3);
		await sleep(400);
		expect(seen.map(named)).toEqual(["F0"]);
		// A viewer who starts watching between browsers gets no stale frame; clearing again changes nothing.
		const late: LiveFrame[] = [];
		screen.watch((frame) => late.push(frame), "low");
		await screen.clear();
		expect(late).toEqual([]);
		expect(failed.started()).toHaveLength(1);

		await screen.show(next.tab);
		expect(next.running()).toBe(true);
		next.frame("N0");
		expect(late.map(named)).toEqual(["N0"]);
		expect(late[0]?.url).toBe("https://kit.example/next");
		await screen.close();
		expect(next.running()).toBe(false);
	});

	test("a still tab's first-frame screenshot that comes after the screen was cleared is dropped", async () => {
		const screen = new LiveScreen();
		const still = fakeTab();
		const send = still.tab.session.send.bind(still.tab.session);
		(still.tab.session as unknown as { send: typeof send }).send = (async (method: string, params?: Record<string, unknown>) => {
			await send(method as never, params as never);
			if (method === "Page.getLayoutMetrics") {
				// The screen is cleared while the screenshot is taken.
				void screen.clear();
				return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
			}
			if (method === "Page.captureScreenshot") return { data: Buffer.from("STILL").toString("base64") };
			return {};
		}) as typeof send;
		const seen: LiveFrame[] = [];
		screen.watch((frame) => seen.push(frame), "low");
		await screen.show(still.tab);
		await sleep(400);
		expect(still.sent.some((call) => call.method === "Page.captureScreenshot")).toBe(true);
		expect(seen).toEqual([]);
		await screen.close();
	});

	test("every frame is acknowledged; each viewer gets frames at its own rate, the newest one it skipped once the page stays still, and the newest at once when it starts watching", async () => {
		const screen = new LiveScreen();
		const tab = fakeTab();
		const low: LiveFrame[] = [];
		const high: LiveFrame[] = [];
		screen.watch((frame) => low.push(frame), "low");
		screen.watch((frame) => high.push(frame), "high");
		await screen.show(tab.tab);
		await settle();
		for (let index = 0; index < 5; index += 1) tab.frame(`F${index}`);
		expect(tab.sent.filter((call) => call.method === "Page.screencastFrameAck")).toHaveLength(5);
		expect(low.map(named)).toEqual(["F0"]);
		expect(high.map(named)).toEqual(["F0"]);
		expect(low[0]).toEqual({ jpeg: Buffer.from("F0"), url: "https://kit.example/", width: 1920, height: 963 });
		// The page stays still after F4: both still get it, each when its rate allows.
		await sleep(90);
		expect(high.map(named)).toEqual(["F0", "F4"]);
		expect(low.map(named)).toEqual(["F0"]);
		await sleep(300);
		expect(low.map(named)).toEqual(["F0", "F4"]);

		const late: LiveFrame[] = [];
		screen.watch((frame) => late.push(frame), "low");
		expect(late.map(named)).toEqual(["F4"]);
	});

	test("a viewer that stops watching gets no frame it skipped; a closed screen stops and says it ended", async () => {
		const screen = new LiveScreen();
		const tab = fakeTab();
		const seen: LiveFrame[] = [];
		const stop = screen.watch((frame) => seen.push(frame), "low");
		await screen.show(tab.tab);
		await settle();
		tab.frame("F0");
		tab.frame("F1");
		stop();
		await sleep(400);
		expect(seen.map(named)).toEqual(["F0"]);

		screen.watch(() => undefined, "high");
		await settle();
		let ended = false;
		void screen.ended.then(() => { ended = true; });
		await screen.close();
		await settle();
		expect(ended).toBe(true);
		expect(tab.running()).toBe(false);
		// Nothing starts again on a closed screen.
		screen.watch(() => undefined, "high");
		await settle();
		expect(tab.running()).toBe(false);
	});
});
