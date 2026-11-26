import type { RawData, WebSocket } from "ws";
import { z } from "zod";

import { MAX_MESSAGE, visitControlOf, type ControlResult, type VisitControl, type VisitControlEvent } from "./control";
import { LIVE_INPUT } from "./live_input";
import { encodeFrame, MAX_CLIENT_MESSAGE, type ServerMessage } from "./live_protocol";
import type { LiveFrame } from "./screen";

/**
 * One viewer's socket to a live visit: the screen as binary frames, the
 * control state (with whether this viewer drives) on connect and on every
 * change, and the viewer's commands and inputs. A frame is sent only once
 * the one before left the server, so a slow connection gets fewer, newer
 * frames instead of a backlog.
 */

/** People watching one visit at once; each holds a frame in memory. */
export const MAX_VIEWERS = 50;
/** Pings keep proxies (the Cloudflare tunnel) from closing a socket whose screen stays still. */
const PING_MS = 25_000;

/** A viewer's own random id, kept by its browser tab: its key to the controls while it drives. */
const VIEWER = z.string().regex(/^[A-Za-z0-9-]{16,64}$/);
const QUALITY = z.enum(["low", "high"]);
const id = z.number().int().nonnegative();

const CLIENT_MESSAGE = z.discriminatedUnion("type", [
	z.object({ type: z.literal("quality"), quality: QUALITY }),
	z.object({ type: z.literal("take"), id }),
	z.object({ type: z.literal("release"), id, note: z.string().max(MAX_MESSAGE).optional() }),
	z.object({ type: z.literal("message"), id, text: z.string().min(1).max(MAX_MESSAGE) }),
	z.object({ type: z.literal("input"), inputs: z.array(LIVE_INPUT).min(1).max(60) }),
]);

/** Frames are encoded once, whoever watches them. */
const packets = new WeakMap<LiveFrame, Uint8Array>();
function packet(frame: LiveFrame): Uint8Array {
	let encoded = packets.get(frame);
	if (!encoded) {
		encoded = encodeFrame({ url: frame.url, width: frame.width, height: frame.height }, frame.jpeg);
		packets.set(frame, encoded);
	}
	return encoded;
}

function parse(data: RawData): unknown {
	try {
		return JSON.parse(data.toString());
	} catch {
		return undefined;
	}
}

/** Serve a viewer's socket to the live visit of `key` (the case's id) until either side closes it. */
export function serveLiveSocket(socket: WebSocket, key: string, search: URLSearchParams): void {
	const send = (message: ServerMessage) => {
		if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
	};
	const viewer = VIEWER.safeParse(search.get("viewer"));
	if (!viewer.success) return socket.close(1008, "A viewer id is required.");
	const control = visitControlOf(key);
	if (!control || control.mode === "ended") {
		send({ type: "end" });
		return socket.close(1000, "The visit is not live.");
	}
	if (control.screen.viewers >= MAX_VIEWERS) return socket.close(1013, "Too many people watch this visit right now.");
	new LiveSocketSession(socket, control, viewer.data, QUALITY.catch("low").parse(search.get("quality")), send);
}

class LiveSocketSession {
	#stopWatching: () => void;
	#latest?: LiveFrame;
	#sending = false;
	#closed = false;
	readonly #unsubscribe: () => void;
	readonly #ping: ReturnType<typeof setInterval>;

	constructor(
		private readonly socket: WebSocket,
		private readonly control: VisitControl,
		private readonly viewer: string,
		quality: "low" | "high",
		private readonly send: (message: ServerMessage) => void,
	) {
		this.#unsubscribe = control.subscribe((state) => this.#control(state));
		this.#control(control.state);
		this.#stopWatching = this.#watch(quality);
		this.#ping = setInterval(() => socket.ping(), PING_MS);
		socket.on("message", (data, binary) => void this.#receive(data, binary));
		socket.on("close", () => this.#close());
		socket.on("error", () => this.#close());
		void control.screen.ended.then(() => {
			if (this.#closed) return;
			send({ type: "end" });
			socket.close(1000, "The visit ended.");
			this.#close();
		});
	}

	#control(state: VisitControlEvent): void {
		this.send({ ...state, you: this.control.drives(this.viewer) });
	}

	#watch(quality: "low" | "high"): () => void {
		return this.control.screen.watch((frame) => {
			this.#latest = frame;
			this.#pump();
		}, quality);
	}

	#pump(): void {
		const frame = this.#latest;
		if (this.#sending || !frame || this.#closed || this.socket.readyState !== this.socket.OPEN) return;
		this.#latest = undefined;
		this.#sending = true;
		this.socket.send(packet(frame), { binary: true }, () => {
			this.#sending = false;
			this.#pump();
		});
	}

	async #receive(data: RawData, binary: boolean): Promise<void> {
		const size = Array.isArray(data) ? data.reduce((sum, part) => sum + part.length, 0) : data instanceof ArrayBuffer ? data.byteLength : data.length;
		if (binary || size > MAX_CLIENT_MESSAGE) return this.socket.close(1009, "Messages are JSON text of at most 64 KiB.");
		const parsed = CLIENT_MESSAGE.safeParse(parse(data));
		if (!parsed.success) return this.send({ type: "refused", status: 400, error: "Invalid message." });
		const message = parsed.data;
		const { control, viewer } = this;
		switch (message.type) {
			case "quality":
				this.#stopWatching();
				this.#stopWatching = this.#watch(message.quality);
				return;
			case "input": {
				const result = await control.input(viewer, message.inputs);
				if (!result.ok) this.send({ type: "refused", status: result.status, error: result.error });
				return;
			}
			default: {
				const result: ControlResult = message.type === "take" ? control.take(viewer)
					: message.type === "release" ? await control.release(viewer, message.note)
						: control.message(viewer, message.text);
				this.send({ type: "reply", id: message.id, ...(result.ok ? { ok: true } : { ok: false, status: result.status, error: result.error }) });
			}
		}
	}

	#close(): void {
		if (this.#closed) return;
		this.#closed = true;
		clearInterval(this.#ping);
		this.#unsubscribe();
		this.#stopWatching();
		this.#latest = undefined;
	}
}
