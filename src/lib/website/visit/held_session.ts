import type { CDPSession } from "rebrowser-puppeteer-core";

/** A scripted CDP session holding one response, for the tests of reading held bodies. */

/** One piece of a held body as the network delivers it: bytes, a stream that goes quiet for good, or one that breaks. */
export type Piece = Buffer | "quiet" | Error;

/**
 * A CDP session whose held response has a body arriving in `pieces`, read as
 * Chromium streams it: a read answers once it holds `size` bytes or the body
 * ended (a body that goes quiet first leaves it waiting, and what it gathered
 * is lost), as text where the bytes are valid UTF-8 and base64 where not.
 * Every command is logged.
 */
export function streamingSession(pieces: Iterable<Piece>, options: { untakeable?: boolean } = {}) {
	const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
	const source = pieces[Symbol.iterator]();
	let current: Piece | undefined;
	let closed = false;
	const next = (): Piece | undefined => {
		if (current instanceof Buffer && current.byteLength > 0) return current;
		const step = source.next();
		current = step.done ? undefined : step.value;
		return current;
	};
	const listeners = new Map<string, (payload: unknown) => void>();
	const session = {
		on: (event: string, listener: (payload: unknown) => void) => { listeners.set(event, listener); },
		off: (event: string) => { listeners.delete(event); },
		detach: async () => { commands.push({ method: "detach" }); },
		send: async (method: string, params?: Record<string, unknown>) => {
			commands.push({ method, ...(params ? { params } : {}) });
			if (method === "Fetch.takeResponseBodyAsStream") {
				if (options.untakeable) throw new Error("Can only get response body on HeadersReceived pattern matched requests.");
				return { stream: "stream-1" };
			}
			if (method === "IO.close") {
				closed = true;
				return {};
			}
			if (method !== "IO.read") return {};
			if (closed) throw new Error("Invalid stream handle");
			const size = Number(params?.size ?? 1024 * 1024);
			const gathered: Buffer[] = [];
			let length = 0;
			while (length < size) {
				const piece = next();
				if (piece === "quiet") return new Promise(() => undefined);
				if (piece instanceof Error) throw piece;
				if (!piece) break;
				const taken = piece.subarray(0, size - length);
				current = piece.subarray(taken.byteLength);
				gathered.push(taken);
				length += taken.byteLength;
			}
			const chunk = Buffer.concat(gathered);
			const eof = length < size;
			const text = chunk.toString("utf8");
			return Buffer.from(text).equals(chunk) ? { data: text, base64Encoded: false, eof } : { data: chunk.toString("base64"), base64Encoded: true, eof };
		},
	};
	return {
		session: session as unknown as CDPSession,
		commands,
		/** Deliver an event to the session's listener, as the browser does. */
		emit: (event: string, payload: unknown) => listeners.get(event)?.(payload),
		/** The bytes every read asked for, in order. */
		readSizes: () => commands.filter(({ method }) => method === "IO.read").map(({ params }) => Number(params!.size)),
		closes: () => commands.filter(({ method }) => method === "IO.close").length,
	};
}
