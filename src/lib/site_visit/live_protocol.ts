import type { VisitControlEvent } from "./control";
import type { LiveInput } from "./live_input";

/**
 * The live visit's WebSocket (`/api/live/{id}/socket?viewer=…&quality=…`),
 * shared by its server and the console: one connection per viewer carries
 * the screen (binary frames), the control state, and the viewer's commands
 * and inputs. Text messages are JSON; binary messages are frames.
 */

export type ScreenQuality = "low" | "high";

/** The largest message a viewer may send (a batch of inputs, a command); the socket closes on a larger one. */
export const MAX_CLIENT_MESSAGE = 64 * 1024;

/** What the console sends. Inputs are sent as they happen; only a refusal is answered. */
export type ClientMessage =
	| { type: "quality"; quality: ScreenQuality }
	| { type: "take"; id: number }
	| { type: "release"; id: number; note?: string }
	| { type: "message"; id: number; text: string }
	| { type: "input"; inputs: LiveInput[] };

export type CommandReply = { type: "reply"; id: number } & ({ ok: true } | { ok: false; status: number; error: string });

/** What the server sends as text. `you`: this viewer drives the browser. */
export type ServerMessage =
	| (VisitControlEvent & { you: boolean })
	| CommandReply
	| { type: "refused"; status: number; error: string }
	| { type: "end" };

/** The page's CSS size and address a frame shows; input coordinates are in that size. */
export type FrameMeta = { url: string; width: number; height: number };

/** Where a viewer's socket is. */
export function liveSocketPath(submissionId: string, viewer: string, quality: ScreenQuality): string {
	return `/api/live/${encodeURIComponent(submissionId)}/socket?${new URLSearchParams({ viewer, quality })}`;
}

/** A frame on the wire: the length of its metadata (4 bytes, big-endian), the metadata as JSON, then the JPEG. */
export function encodeFrame(meta: FrameMeta, jpeg: Uint8Array): Uint8Array {
	const head = new TextEncoder().encode(JSON.stringify(meta));
	const packet = new Uint8Array(4 + head.length + jpeg.length);
	new DataView(packet.buffer).setUint32(0, head.length);
	packet.set(head, 4);
	packet.set(jpeg, 4 + head.length);
	return packet;
}

export function decodeFrame(data: ArrayBuffer): { meta: FrameMeta; jpeg: Uint8Array } | undefined {
	if (data.byteLength < 4) return undefined;
	const length = new DataView(data).getUint32(0);
	if (4 + length > data.byteLength) return undefined;
	try {
		const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, length))) as Partial<FrameMeta>;
		if (!(Number(meta.width) > 0) || !(Number(meta.height) > 0)) return undefined;
		return { meta: { url: typeof meta.url === "string" ? meta.url : "", width: Number(meta.width), height: Number(meta.height) }, jpeg: new Uint8Array(data, 4 + length) };
	} catch {
		return undefined;
	}
}
