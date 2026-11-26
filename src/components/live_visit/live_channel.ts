import type { LiveInput } from "@/lib/site_visit/live_input";
import { decodeFrame, type ClientMessage, type FrameMeta, type ScreenQuality, type ServerMessage } from "@/lib/site_visit/live_protocol";

/**
 * A viewer's connection to a live visit: one WebSocket for the screen, the
 * control state, commands (answered) and inputs (sent as they happen). A
 * dropped connection comes back on its own until the visit says it ended;
 * commands waiting for an answer then fail, and the server resumes a turn
 * the viewer drove on the new connection.
 */

export type CommandResult = { ok: true } | { ok: false; status: number; error: string };
export type Command = { type: "take" } | { type: "release"; note?: string } | { type: "message"; text: string };
export type ControlMessage = Extract<ServerMessage, { type: "browser.control" }>;
export type Refusal = { status: number; error: string };

export type ChannelHandlers = {
	onFrame: (meta: FrameMeta, jpeg: Uint8Array) => void;
	onControl: (control: ControlMessage) => void;
	onConnected: (connected: boolean) => void;
	onEnd: () => void;
};

type SocketLike = Pick<WebSocket, "readyState" | "send" | "close" | "addEventListener"> & { binaryType: BinaryType };

export type ChannelOptions = {
	url: (quality: ScreenQuality) => string;
	quality: ScreenQuality;
	handlers: ChannelHandlers;
	connect?: (url: string) => SocketLike;
	/** How long the first reconnect waits; each next one waits twice as long, up to `MAX_RETRY_MS`. */
	retryMs?: number;
};

const MAX_RETRY_MS = 10_000;
const OPEN = 1;
const DROPPED: CommandResult = { ok: false, status: 0, error: "The connection to the visit dropped; try again." };

export class LiveChannel {
	readonly #options: ChannelOptions;
	#socket?: SocketLike;
	#quality: ScreenQuality;
	#nextId = 0;
	readonly #waiting = new Map<number, (result: CommandResult) => void>();
	readonly #refusals = new Set<(refusal: Refusal) => void>();
	#retryMs: number;
	#retry?: ReturnType<typeof setTimeout>;
	/** The visit ended, or the viewer left: no reconnecting. */
	#done = false;

	constructor(options: ChannelOptions) {
		this.#options = options;
		this.#quality = options.quality;
		this.#retryMs = options.retryMs ?? 1_000;
		this.#open();
	}

	get connected(): boolean {
		return this.#socket?.readyState === OPEN;
	}

	/** The sharp screen (full screen, driving) or the small one; kept for a reconnect. */
	setQuality(quality: ScreenQuality): void {
		if (quality === this.#quality) return;
		this.#quality = quality;
		this.#send({ type: "quality", quality });
	}

	/** Take over, hand back or write to the agent; resolves with the visit's answer. */
	request(command: Command): Promise<CommandResult> {
		const id = this.#nextId++;
		if (!this.#send({ ...command, id })) return Promise.resolve(DROPPED);
		return new Promise((resolve) => this.#waiting.set(id, resolve));
	}

	/** Send the driver's inputs now; false while not connected. */
	input(inputs: LiveInput[]): boolean {
		return this.#send({ type: "input", inputs });
	}

	/** Hear when the visit refuses an input (not driving, too many, the agent finishing its action). */
	onRefused(listener: (refusal: Refusal) => void): () => void {
		this.#refusals.add(listener);
		return () => this.#refusals.delete(listener);
	}

	close(): void {
		this.#done = true;
		clearTimeout(this.#retry);
		this.#socket?.close(1000);
		this.#settle();
	}

	#send(message: ClientMessage): boolean {
		if (this.#socket?.readyState !== OPEN) return false;
		this.#socket.send(JSON.stringify(message));
		return true;
	}

	#open(): void {
		const { handlers } = this.#options;
		const socket = (this.#options.connect ?? ((url) => new WebSocket(url)))(this.#options.url(this.#quality));
		socket.binaryType = "arraybuffer";
		this.#socket = socket;
		socket.addEventListener("open", () => {
			if (this.#socket !== socket) return;
			this.#retryMs = this.#options.retryMs ?? 1_000;
			handlers.onConnected(true);
		});
		socket.addEventListener("message", (event) => {
			if (this.#socket !== socket) return;
			if (typeof event.data !== "string") {
				const frame = decodeFrame(event.data as ArrayBuffer);
				if (frame) handlers.onFrame(frame.meta, frame.jpeg);
				return;
			}
			this.#receive(event.data);
		});
		socket.addEventListener("close", () => {
			if (this.#socket !== socket) return;
			this.#socket = undefined;
			this.#settle();
			handlers.onConnected(false);
			if (this.#done) return;
			this.#retry = setTimeout(() => this.#open(), this.#retryMs);
			this.#retryMs = Math.min(MAX_RETRY_MS, this.#retryMs * 2);
		});
	}

	#receive(data: string): void {
		let message: ServerMessage;
		try {
			message = JSON.parse(data) as ServerMessage;
		} catch {
			return;
		}
		switch (message.type) {
			case "browser.control":
				this.#options.handlers.onControl(message);
				return;
			case "reply": {
				const resolve = this.#waiting.get(message.id);
				this.#waiting.delete(message.id);
				resolve?.(message.ok ? { ok: true } : { ok: false, status: message.status, error: message.error });
				return;
			}
			case "refused":
				for (const listener of this.#refusals) listener({ status: message.status, error: message.error });
				return;
			case "end":
				this.#done = true;
				this.#options.handlers.onEnd();
		}
	}

	/** Commands still waiting will not be answered on this connection. */
	#settle(): void {
		for (const resolve of this.#waiting.values()) resolve(DROPPED);
		this.#waiting.clear();
	}
}
