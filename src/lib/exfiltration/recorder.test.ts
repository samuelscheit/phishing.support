import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { ExfiltrationNetworkRecorder } from "./recorder";

class FakeSession extends EventEmitter {
	readonly sent: string[] = [];
	detached = false;
	constructor(private readonly connections: FakeConnection) { super(); }
	async send(method: string) {
		this.sent.push(method);
		if (method === "Network.getRequestPostData") return { postData: "email=late-body" };
		return {};
	}
	async detach() { this.detached = true; }
	connection() { return this.connections; }
}

class FakeConnection {
	readonly sessions = new Map<string, FakeSession>();
	session(id: string) { return this.sessions.get(id); }
	/** A child target the parent session auto-attaches, held until the recorder releases it. */
	attach(parent: FakeSession, id: string, type: string): FakeSession {
		const child = new FakeSession(this);
		this.sessions.set(id, child);
		parent.emit("Target.attachedToTarget", { sessionId: id, targetInfo: { targetId: id, type }, waitingForDebugger: true });
		return child;
	}
}

function setup() {
	const connection = new FakeConnection();
	const root = new FakeSession(connection);
	const browser = { target: () => ({ createCDPSession: async () => root }) };
	return { connection, root, browser: browser as never, recorder: new ExfiltrationNetworkRecorder() };
}

describe("CDP exfiltration recorder", () => {
	test("captures inline, deferred, beacon, and WebSocket payloads from attached targets", async () => {
		const { connection, root, browser, recorder } = setup();
		await recorder.start(browser);
		const session = connection.attach(root, "page-1", "page");
		session.emit("Network.requestWillBeSent", { requestId: "1", type: "Fetch", request: { url: "https://collector.example/a", method: "POST", postData: "password=inline" } });
		session.emit("Network.requestWillBeSent", { requestId: "2", type: "Ping", request: { url: "https://collector.example/beacon", method: "POST", hasPostData: true } });
		session.emit("Network.webSocketCreated", { requestId: "ws-1", url: "wss://collector.example/socket" });
		session.emit("Network.webSocketFrameSent", { requestId: "ws-1", response: { payloadData: "code=123456" } });
		await Promise.resolve();
		await Promise.resolve();
		const captured = await recorder.stop();
		expect(captured).toEqual(expect.arrayContaining([
			expect.objectContaining({ url: "https://collector.example/a", postData: "password=inline" }),
			expect.objectContaining({ url: "https://collector.example/beacon", postData: "email=late-body", resourceType: "Ping" }),
			expect.objectContaining({ url: "wss://collector.example/socket", method: "WEBSOCKET", webSocketPayload: "code=123456" }),
		]));
	});

	test("enables Network and auto-attach on a held target before it is released to run", async () => {
		const { connection, root, browser, recorder } = setup();
		await recorder.start(browser);
		expect(root.sent).toEqual(["Target.setAutoAttach"]);
		const frame = connection.attach(root, "frame", "iframe");
		expect(frame.sent).toEqual(["Network.enable", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"]);
		await recorder.stop();
	});

	test("records children of children: a worker of an out-of-process frame", async () => {
		const { connection, root, browser, recorder } = setup();
		await recorder.start(browser);
		const frame = connection.attach(root, "frame", "iframe");
		const worker = connection.attach(frame, "worker", "worker");
		worker.emit("Network.requestWillBeSent", { requestId: "1", type: "Fetch", request: { url: "https://drop.example/check", method: "POST", postData: "email=canary" } });
		const captured = await recorder.stop();
		expect(captured).toEqual([expect.objectContaining({ url: "https://drop.example/check", postData: "email=canary" })]);
	});

	test("releases and detaches non-network and duplicate targets without recording them", async () => {
		const { connection, root, browser, recorder } = setup();
		await recorder.start(browser);
		const hub = connection.attach(root, "hub", "other");
		expect(hub.sent).toEqual(["Runtime.runIfWaitingForDebugger"]);
		expect(hub.detached).toBeTrue();
		connection.attach(root, "page", "page");
		connection.sessions.set("again", new FakeSession(connection));
		root.emit("Target.attachedToTarget", { sessionId: "again", targetInfo: { targetId: "page", type: "page" }, waitingForDebugger: true });
		const duplicate = connection.session("again")!;
		expect(duplicate.sent).toEqual(["Runtime.runIfWaitingForDebugger"]);
		expect(duplicate.detached).toBeTrue();
		await recorder.stop();
	});
});
