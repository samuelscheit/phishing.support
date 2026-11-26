import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { NextRequest } from "next/server";

import type { VisitorTabs } from "@/lib/browser/visitor_tabs";
import { closeVisitControl, openVisitControl, viewerLabel, type VisitControlEvent } from "@/lib/site_visit/control";
import { syntheticVisitValues } from "@/lib/site_visit/visit_task";
import { createExfiltrationCanaries } from "@/lib/exfiltration/canaries";
import { POST } from "./route";
import { GET } from "./screen/route";

const ALICE = "alice-route-00000000000";
const BOB = "bob-route-0000000000000";

/** A live control on a fake visit whose tab the test can play screencast frames on. */
function liveVisit(id: string) {
	const events: VisitControlEvent[] = [];
	const session = Object.assign(new EventEmitter(), { send: async () => ({}) });
	const tab = { targetId: "T1", session, page: { url: () => "https://kit.example/login", title: async () => "Sign in" }, closed: false };
	const control = openVisitControl(id, (event) => events.push(event));
	control.attach({
		tabs: { first: tab, active: () => tab, tabs: () => [tab] } as unknown as VisitorTabs,
		touch: false,
		values: syntheticVisitValues(createExfiltrationCanaries()),
		recordStep: async () => true,
		onAction: () => undefined,
		onDriving: () => undefined,
	});
	let frameId = 0;
	return { control, events, frame: (data: string) => session.emit("Page.screencastFrame", { data, sessionId: ++frameId, metadata: { deviceWidth: 393, deviceHeight: 852 } }) };
}

const post = (id: string, body: unknown) => POST(new NextRequest(`http://localhost/api/live/${id}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ id }) });

describe("driving a case's live visit over HTTP", () => {
	test("rejects malformed commands, and every command for a visit that is not live", async () => {
		const id = `live-route-${Math.random()}`;
		for (const body of ["{", { action: "take" }, { action: "take", viewer: "short" }, { action: "take", viewer: "has spaces in it !!!!" }, { action: "fly", viewer: ALICE }, { action: "input", viewer: ALICE, token: "x", inputs: [] }, { action: "message", viewer: ALICE, text: "x".repeat(501) }]) {
			expect((await post(id, body)).status).toBe(400);
		}
		const response = await post(id, { action: "take", viewer: ALICE });
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "The visit is not live." });
	});

	test("take, input, message and hand back; another viewer is refused while one drives; bad input is refused whole", async () => {
		const id = `live-route-${Math.random()}`;
		const { control, events } = liveVisit(id);
		try {
			const taken = await post(id, { action: "take", viewer: ALICE });
			expect(taken.status).toBe(200);
			const { token } = await taken.json() as { token: string };
			expect(token).toMatch(/^[0-9a-f-]{36}$/);

			const refused = await post(id, { action: "take", viewer: BOB });
			expect(refused.status).toBe(409);
			expect(await refused.json()).toEqual({ error: `${viewerLabel(ALICE)} is driving the browser.` });

			// Until the agent pauses, input waits.
			expect((await post(id, { action: "input", viewer: ALICE, token, inputs: [{ type: "reload" }] })).status).toBe(409);
			void control.steering.checkpoint(new AbortController().signal);
			await Promise.resolve();
			expect(await (await post(id, { action: "input", viewer: ALICE, token, inputs: [{ type: "pointer", phase: "down", x: 1, y: 2 }, { type: "pointer", phase: "up", x: 1, y: 2 }] })).json()).toEqual({});
			// A coordinate off any screen, an unknown made-up field, or a URL to open are refused.
			for (const inputs of [[{ type: "pointer", phase: "down", x: -1, y: 2 }], [{ type: "fake", field: "ssn" }], [{ type: "navigate", url: "https://example.com" }]]) {
				expect((await post(id, { action: "input", viewer: ALICE, token, inputs })).status).toBe(400);
			}
			expect((await post(id, { action: "input", viewer: BOB, token, inputs: [{ type: "reload" }] })).status).toBe(403);

			expect((await post(id, { action: "message", viewer: BOB, text: "Try the second button" })).status).toBe(200);
			expect((await post(id, { action: "release", viewer: BOB, token })).status).toBe(403);
			expect((await post(id, { action: "release", viewer: ALICE, token, note: "done" })).status).toBe(200);
			expect(events.at(-1)).toMatchObject({ mode: "agent" });
		} finally {
			await closeVisitControl(control);
		}
	});
});

describe("the live screen over server-sent events", () => {
	test("is not found when the visit is not live", async () => {
		const id = `live-screen-${Math.random()}`;
		const response = await GET(new NextRequest(`http://localhost/api/live/${id}/screen`), { params: Promise.resolve({ id }) });
		expect(response.status).toBe(404);
	});

	test("streams the newest frame each time the client reads, and ends with the visit", async () => {
		const id = `live-screen-${Math.random()}`;
		const { control, frame } = liveVisit(id);
		const response = await GET(new NextRequest(`http://localhost/api/live/${id}/screen?quality=high`), { params: Promise.resolve({ id }) });
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		const reader = response.body!.getReader() as ReadableStreamDefaultReader<string | Uint8Array>;
		const read = async () => {
			const { value } = await reader.read();
			return typeof value === "string" ? value : new TextDecoder().decode(value);
		};
		expect(await read()).toBe(": connected\n\n");
		await new Promise((resolve) => setTimeout(resolve, 10));
		// Three frames while the client did not read: it gets the newest only.
		frame("F1");
		await new Promise((resolve) => setTimeout(resolve, 80));
		frame("F2");
		await new Promise((resolve) => setTimeout(resolve, 80));
		frame("F3");
		const first = await read();
		expect(JSON.parse(first.replace(/^data: /, ""))).toEqual({ jpeg: "F1", url: "https://kit.example/login", width: 393, height: 852 });
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(JSON.parse((await read()).replace(/^data: /, ""))).toMatchObject({ jpeg: "F3" });
		const ending = read();
		await closeVisitControl(control);
		expect(await ending).toBe("event: end\ndata: {}\n\n");
		expect((await reader.read()).done).toBe(true);
	});

	test("a client that leaves stops watching, and nothing is written to its stream after", async () => {
		const id = `live-screen-${Math.random()}`;
		const { control, frame } = liveVisit(id);
		try {
			const aborted = new AbortController();
			const response = await GET(new NextRequest(`http://localhost/api/live/${id}/screen`, { signal: aborted.signal }), { params: Promise.resolve({ id }) });
			const reader = response.body!.getReader();
			await reader.read();
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(control.screen.viewers).toBe(1);
			const waiting = reader.read();
			aborted.abort();
			await reader.cancel();
			await waiting.catch(() => undefined);
			frame("late");
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(control.screen.viewers).toBe(0);
		} finally {
			await closeVisitControl(control);
		}
	});
});
