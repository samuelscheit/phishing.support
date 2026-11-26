import { afterEach, describe, expect, test } from "bun:test";

import { encodeFrame } from "@/lib/site_visit/live_protocol";
import { LiveChannel, type ChannelHandlers, type ControlMessage } from "./live_channel";

type Listener = (event: { data?: unknown }) => void;

/** A socket the test plays the server's side of. */
class FakeSocket {
	readyState = 0;
	binaryType: BinaryType = "blob";
	readonly sent: unknown[] = [];
	readonly #listeners = new Map<string, Listener[]>();
	constructor(readonly url: string) {}
	addEventListener(type: string, listener: Listener) {
		this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
	}
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {
		this.drop();
	}
	emit(type: string, data?: unknown) {
		for (const listener of this.#listeners.get(type) ?? []) listener({ data });
	}
	open() {
		this.readyState = 1;
		this.emit("open");
	}
	drop() {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.emit("close");
	}
	reply(message: unknown) {
		this.emit("message", JSON.stringify(message));
	}
}

const channels: LiveChannel[] = [];
afterEach(() => {
	for (const channel of channels.splice(0)) channel.close();
});

function harness() {
	const sockets: FakeSocket[] = [];
	const heard = { frames: [] as Array<{ url: string; bytes: number[] }>, controls: [] as ControlMessage[], connected: [] as boolean[], ended: 0 };
	const handlers: ChannelHandlers = {
		onFrame: (meta, jpeg) => heard.frames.push({ url: meta.url, bytes: [...jpeg] }),
		onControl: (control) => heard.controls.push(control),
		onConnected: (connected) => heard.connected.push(connected),
		onEnd: () => {
			heard.ended += 1;
		},
	};
	const channel = new LiveChannel({
		url: (quality) => `/socket?quality=${quality}`,
		quality: "low",
		handlers,
		retryMs: 5,
		connect: (url) => {
			const socket = new FakeSocket(url);
			sockets.push(socket);
			return socket as unknown as WebSocket;
		},
	});
	channels.push(channel);
	return { channel, sockets, heard };
}

const control = (you: boolean) => ({ type: "browser.control", run: "r1", seq: 1, mode: "human", tabs: [], fakeValues: {}, agentRunning: true, you }) as ControlMessage;

describe("LiveChannel", () => {
	test("frames, control states and command replies reach their places; commands are answered by id", async () => {
		const { channel, sockets, heard } = harness();
		const [socket] = sockets;
		expect(socket!.binaryType).toBe("arraybuffer");
		expect(await channel.request({ type: "take" })).toEqual({ ok: false, status: 0, error: expect.stringContaining("dropped") });
		socket!.open();
		expect(heard.connected).toEqual([true]);

		const packet = encodeFrame({ url: "https://kit.example/", width: 393, height: 852 }, new Uint8Array([0xff, 0xd8, 1]));
		socket!.emit("message", packet.buffer);
		expect(heard.frames).toEqual([{ url: "https://kit.example/", bytes: [0xff, 0xd8, 1] }]);
		socket!.reply(control(true));
		expect(heard.controls).toEqual([control(true)]);

		const take = channel.request({ type: "take" });
		const message = channel.request({ type: "message", text: "hi" });
		expect(socket!.sent).toEqual([{ type: "take", id: 1 }, { type: "message", text: "hi", id: 2 }]);
		socket!.reply({ type: "reply", id: 2, ok: false, status: 429, error: "Wait a moment before the next message." });
		socket!.reply({ type: "reply", id: 1, ok: true });
		expect(await take).toEqual({ ok: true });
		expect(await message).toEqual({ ok: false, status: 429, error: "Wait a moment before the next message." });

		const refusals: unknown[] = [];
		const stop = channel.onRefused((refusal) => refusals.push(refusal));
		expect(channel.input([{ type: "reload" }])).toBe(true);
		socket!.reply({ type: "refused", status: 403, error: "You are not driving the browser." });
		stop();
		socket!.reply({ type: "refused", status: 429, error: "Too many inputs at once." });
		expect(refusals).toEqual([{ status: 403, error: "You are not driving the browser." }]);
		socket!.emit("message", "{not json");
	});

	test("a dropped connection fails waiting commands and comes back with the quality asked for since", async () => {
		const { channel, sockets, heard } = harness();
		sockets[0]!.open();
		const waiting = channel.request({ type: "release" });
		channel.setQuality("high");
		expect(sockets[0]!.sent.at(-1)).toEqual({ type: "quality", quality: "high" });
		sockets[0]!.drop();
		expect(await waiting).toEqual({ ok: false, status: 0, error: expect.stringContaining("dropped") });
		expect(channel.connected).toBe(false);
		expect(channel.input([{ type: "reload" }])).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(sockets).toHaveLength(2);
		expect(sockets[1]!.url).toBe("/socket?quality=high");
		sockets[1]!.open();
		expect(heard.connected).toEqual([true, false, true]);
	});

	test("does not come back once the visit ended, or once closed", async () => {
		const ended = harness();
		ended.sockets[0]!.open();
		ended.sockets[0]!.reply({ type: "end" });
		ended.sockets[0]!.drop();
		const closed = harness();
		closed.sockets[0]!.open();
		closed.channel.close();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(ended.heard.ended).toBe(1);
		expect(ended.sockets).toHaveLength(1);
		expect(closed.sockets).toHaveLength(1);
	});
});
