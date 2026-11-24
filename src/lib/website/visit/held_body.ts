import type { CDPSession } from "rebrowser-puppeteer-core";

/**
 * The body of a response held in the Fetch domain's response stage, read
 * without ever holding more of it than a cap or waiting on it longer than a
 * bound. `Fetch.getResponseBody` buffers the whole body in the browser and
 * answers only once all of it arrived: a body that never ends (a tarpit
 * streaming HTML forever) would hold the response, and the memory, for as long
 * as it streams. The body is taken as a stream and read in pieces instead.
 * Once taken, the response can no longer go on as it came: whoever takes it
 * answers it (`Fetch.fulfillRequest` or `Fetch.failRequest`).
 */

/** How much of a body is read, and for how long. */
export type BodyLimits = { maxBytes: number; timeoutMs: number };

/**
 * What arrived of a held body: all of it, or the pieces read before the cap,
 * the bound or a broken stream cut it off (never more than the cap), and why.
 */
export type HeldBody = { complete: true; bytes: Buffer } | { complete: false; bytes: Buffer; reason: string };

/**
 * The most one `IO.read` asks for. Chromium answers a read only once it can
 * fill it or the body ends, so what arrived of a piece still being filled when
 * the bound passes is lost: a page that goes quiet keeps all but its last
 * piece. A page smaller than this is one read; one at the cap is 80.
 */
export const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Take the body of a held response and read it, within `limits`. Throws only
 * when the body cannot be taken at all, and the response can then still go on
 * unchanged; once taken, the stream is always closed. Chromium hands the body
 * decoded (no gzip left), as text where it is valid UTF-8 and base64 where it
 * is not.
 */
export async function takeHeldBody(session: CDPSession, requestId: string, limits: BodyLimits): Promise<HeldBody> {
	const { stream } = await session.send("Fetch.takeResponseBodyAsStream", { requestId });
	const chunks: Buffer[] = [];
	let size = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<"expired">((resolve) => { timer = setTimeout(() => resolve("expired"), limits.timeoutMs); });
	const cut = (reason: string): HeldBody => ({ complete: false, bytes: Buffer.concat(chunks, Math.min(size, limits.maxBytes)), reason });
	try {
		for (;;) {
			// One byte past the cap tells a body exactly at the cap from one over it.
			const read = await Promise.race([session.send("IO.read", { handle: stream, size: Math.min(READ_CHUNK_BYTES, limits.maxBytes + 1 - size) }), expired])
				.catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
			if (read === "expired") return cut(`the body was still arriving after ${limits.timeoutMs} ms`);
			if (read instanceof Error) return cut(`the body broke off: ${read.message}`);
			const chunk = Buffer.from(read.data, read.base64Encoded ? "base64" : "utf8");
			chunks.push(chunk);
			size += chunk.byteLength;
			if (size > limits.maxBytes) return cut(`the body is more than ${limits.maxBytes} bytes`);
			if (read.eof) return { complete: true, bytes: Buffer.concat(chunks, size) };
		}
	} finally {
		clearTimeout(timer);
		// A read still waiting on a body that went quiet ends with the stream.
		await session.send("IO.close", { handle: stream }).catch(() => undefined);
	}
}
