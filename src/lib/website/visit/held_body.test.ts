import { describe, expect, test } from "bun:test";

import { READ_CHUNK_BYTES, takeHeldBody } from "./held_body";
import { streamingSession } from "./held_session";

const limits = { maxBytes: 100, timeoutMs: 1_000 };

describe("reading a held body", () => {
	test("reads a body arriving in pieces byte for byte, text and binary alike, and closes its stream", async () => {
		const pieces = [Buffer.from("<html>caf"), Buffer.from([0xc3]), Buffer.from([0xa9, 0xff, 0x00]), Buffer.from("€</html>")];
		const held = streamingSession(pieces);

		const body = await takeHeldBody(held.session, "request-1", limits);

		expect(body).toEqual({ complete: true, bytes: Buffer.concat(pieces) });
		expect(held.commands[0]).toEqual({ method: "Fetch.takeResponseBodyAsStream", params: { requestId: "request-1" } });
		expect(held.closes()).toBe(1);
	});

	test("keeps a body exactly at the cap, and cuts one a byte over it without asking for more than that byte", async () => {
		const atCap = await takeHeldBody(streamingSession([Buffer.alloc(60, "a"), Buffer.alloc(40, "b")]).session, "r", limits);
		expect(atCap).toEqual({ complete: true, bytes: Buffer.concat([Buffer.alloc(60, "a"), Buffer.alloc(40, "b")]) });

		const over = streamingSession([Buffer.alloc(60, "a"), Buffer.alloc(41, "b")]);
		const cut = await takeHeldBody(over.session, "r", limits);
		expect(cut).toEqual({ complete: false, bytes: Buffer.concat([Buffer.alloc(60, "a"), Buffer.alloc(40, "b")]), reason: "the body is more than 100 bytes" });
		expect(over.readSizes()).toEqual([101]);
		expect(over.closes()).toBe(1);
	});

	test("reads a large body in pieces, the last asking only for what is left to a byte past the cap", async () => {
		const cap = 2 * READ_CHUNK_BYTES + 10;
		const atCap = streamingSession([Buffer.alloc(cap, "a")]);
		expect(await takeHeldBody(atCap.session, "r", { maxBytes: cap, timeoutMs: 1_000 })).toEqual({ complete: true, bytes: Buffer.alloc(cap, "a") });
		expect(atCap.readSizes()).toEqual([READ_CHUNK_BYTES, READ_CHUNK_BYTES, 11]);

		const over = streamingSession([Buffer.alloc(cap + 1, "a")]);
		expect(await takeHeldBody(over.session, "r", { maxBytes: cap, timeoutMs: 1_000 })).toEqual({ complete: false, bytes: Buffer.alloc(cap, "a"), reason: `the body is more than ${cap} bytes` });
		expect(over.readSizes()).toEqual([READ_CHUNK_BYTES, READ_CHUNK_BYTES, 11]);
	});

	test("stops a body that never ends at the cap, holding no more than the cap and a byte", async () => {
		function* endless() {
			for (;;) yield Buffer.alloc(30_000, "y");
		}
		const cap = 3 * READ_CHUNK_BYTES;
		const held = streamingSession(endless());

		const body = await takeHeldBody(held.session, "r", { maxBytes: cap, timeoutMs: 1_000 });

		expect(body).toEqual({ complete: false, bytes: Buffer.alloc(cap, "y"), reason: `the body is more than ${cap} bytes` });
		expect(held.readSizes()).toEqual([READ_CHUNK_BYTES, READ_CHUNK_BYTES, READ_CHUNK_BYTES, 1]);
		expect(held.closes()).toBe(1);
	});

	test("gives up on a body that goes quiet once the bound passes, with the pieces read, and closes the stream under the waiting read", async () => {
		// One whole piece arrives, then part of the next: the browser holds that part back until it fills.
		const held = streamingSession([Buffer.alloc(READ_CHUNK_BYTES + 10, "f"), "quiet"]);
		const started = Date.now();

		const body = await takeHeldBody(held.session, "r", { maxBytes: 1024 * 1024, timeoutMs: 200 });

		expect(Date.now() - started).toBeGreaterThanOrEqual(195);
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(body).toEqual({ complete: false, bytes: Buffer.alloc(READ_CHUNK_BYTES, "f"), reason: "the body was still arriving after 200 ms" });
		expect(held.commands.map(({ method }) => method)).toEqual(["Fetch.takeResponseBodyAsStream", "IO.read", "IO.read", "IO.close"]);
	});

	test("ends with the pieces read when the stream breaks off", async () => {
		const held = streamingSession([Buffer.alloc(READ_CHUNK_BYTES + 7, "p"), new Error("net::ERR_CONNECTION_RESET")]);

		expect(await takeHeldBody(held.session, "r", { maxBytes: 1024 * 1024, timeoutMs: 1_000 })).toEqual({ complete: false, bytes: Buffer.alloc(READ_CHUNK_BYTES, "p"), reason: "the body broke off: net::ERR_CONNECTION_RESET" });
		expect(held.closes()).toBe(1);
	});

	test("reads an empty body as complete and empty", async () => {
		expect(await takeHeldBody(streamingSession([]).session, "r", limits)).toEqual({ complete: true, bytes: Buffer.alloc(0) });
	});

	test("throws when the body cannot be taken, and touches no stream", async () => {
		const held = streamingSession([Buffer.from("x")], { untakeable: true });

		await expect(takeHeldBody(held.session, "r", limits)).rejects.toThrow("Can only get response body");
		expect(held.commands.map(({ method }) => method)).toEqual(["Fetch.takeResponseBodyAsStream"]);
	});
});
