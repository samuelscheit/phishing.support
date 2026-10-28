import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { ExfiltrationNetworkRecorder } from "./recorder";

class FakeSession extends EventEmitter {
	async send(method: string) {
		if (method === "Network.getRequestPostData") return { postData: "email=late-body" };
		return {};
	}
	async detach() {}
}

describe("CDP exfiltration recorder", () => {
	test("captures inline, deferred, beacon, and WebSocket payloads from attached targets", async () => {
		const session = new FakeSession();
		const target = {
			_targetId: "page-1",
			type: () => "page",
			url: () => "https://phish.example/",
			createCDPSession: async () => session,
		};
		const browser = Object.assign(new EventEmitter(), { targets: () => [target] });
		const recorder = new ExfiltrationNetworkRecorder();
		await recorder.start(browser as never);
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

	test("ignores non-network targets instead of attaching to the browser process", async () => {
		let attaches = 0;
		const target = { _targetId: "browser", type: () => "browser", url: () => "", createCDPSession: async () => { attaches++; } };
		const browser = Object.assign(new EventEmitter(), { targets: () => [target] });
		const recorder = new ExfiltrationNetworkRecorder();
		await recorder.start(browser as never);
		await recorder.stop();
		expect(attaches).toBe(0);
	});
});
