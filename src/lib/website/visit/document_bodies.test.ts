import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import type { Browser } from "rebrowser-puppeteer-core";

import { chromiumAvailable, launchTestChromium } from "../../browser/task/test_helpers";
import { targetIdOf } from "../../browser/visitor_tabs";
import { DOCUMENT_BODY_LIMITS, interceptDocumentAnswers, passDocument, type DocumentAnswer, type PausedDocument } from "./document_bodies";
import { READ_CHUNK_BYTES } from "./held_body";
import { streamingSession, type Piece } from "./held_session";

const MAIN = "main-frame";
const limits = { maxBytes: 100, timeoutMs: 1_000 };

function paused(status: number, headers: Record<string, string> = { "Content-Type": "text/html" }, frameId = MAIN): PausedDocument {
	return { requestId: "request-1", frameId, request: { url: "https://kit.example/page" }, responseStatusCode: status, responseStatusText: status === 200 ? "OK" : "", responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })) };
}

/** Pass one held response whose body arrives in `pieces`; the log holds every command, and `record` where an answer was recorded. */
async function pass(response: PausedDocument, pieces: Piece[], options: { untakeable?: boolean; limits?: typeof limits } = {}) {
	const held = streamingSession(pieces, options);
	const answers: DocumentAnswer[] = [];
	await passDocument(held.session, response, MAIN, (answer) => {
		answers.push(answer);
		held.commands.push({ method: "record" });
	}, options.limits ?? limits);
	const fulfilled = held.commands.find(({ method }) => method === "Fetch.fulfillRequest")?.params as { body: string } | undefined;
	return { ...held, answers, methods: held.commands.map(({ method }) => method), fulfilledBody: fulfilled && Buffer.from(fulfilled.body, "base64") };
}

describe("letting a held document go on", () => {
	test("answers a page with the bytes read, its status and headers but those of the wire, and records its body first", async () => {
		const page = "<html><body>Sign in</body></html>";
		const passed = await pass(paused(200, { "Content-Type": "text/html", "Content-Length": "33", "Content-Encoding": "gzip", "transfer-encoding": "chunked", "Set-Cookie": "kit=1", "X-Kit": "v2" }), [Buffer.from(page.slice(0, 10)), Buffer.from(page.slice(10))]);

		expect(passed.methods).toEqual(["Fetch.takeResponseBodyAsStream", "IO.read", "IO.close", "record", "Fetch.fulfillRequest"]);
		expect(passed.commands.at(-1)!.params).toEqual({
			requestId: "request-1",
			responseCode: 200,
			responsePhrase: "OK",
			responseHeaders: [{ name: "Content-Type", value: "text/html" }, { name: "Set-Cookie", value: "kit=1" }, { name: "X-Kit", value: "v2" }],
			body: Buffer.from(page).toString("base64"),
		});
		expect(passed.answers).toEqual([{ url: "https://kit.example/page", status: 200, receivedAt: expect.any(String), body: Buffer.from(page) }]);
		expect(Number.isFinite(Date.parse(passed.answers[0]!.receivedAt))).toBe(true);
	});

	test("lets another frame's document go on untouched, and records nothing", async () => {
		const passed = await pass(paused(200, undefined, "child-frame"), [Buffer.from("framed")]);

		expect(passed.methods).toEqual(["Fetch.continueRequest"]);
		expect(passed.answers).toEqual([]);
	});

	test("records a redirect, an error, a download and a page declared over the cap without reading them, and lets them go on", async () => {
		for (const response of [
			paused(302, { Location: "https://kit.example/next" }),
			paused(404),
			paused(200, { "Content-Type": "text/html", "Content-Disposition": "attachment; filename=\"fix.hta\"" }),
			paused(200, { "Content-Type": "application/zip" }),
			paused(200, { "Content-Type": "text/html", "Content-Length": "101" }),
		]) {
			const passed = await pass(response, [Buffer.from("body")]);
			expect(passed.methods).toEqual(["record", "Fetch.continueRequest"]);
			expect(passed.answers).toEqual([{ url: "https://kit.example/page", status: response.responseStatusCode!, receivedAt: expect.any(String) }]);
		}
	});

	test("keeps a page declared exactly at the cap", async () => {
		const passed = await pass(paused(200, { "Content-Type": "text/html", "Content-Length": "100" }), [Buffer.alloc(100, "p")]);

		expect(passed.answers[0]!.body).toEqual(Buffer.alloc(100, "p"));
		expect(passed.fulfilledBody).toEqual(Buffer.alloc(100, "p"));
	});

	test("shows a page past the cap up to the cap and keeps no body of it", async () => {
		function* endless() {
			for (;;) yield Buffer.alloc(40, "y");
		}
		const passed = await pass(paused(200), [...take(endless(), 50)]);

		expect(passed.answers).toEqual([{ url: "https://kit.example/page", status: 200, receivedAt: expect.any(String) }]);
		expect(passed.fulfilledBody).toEqual(Buffer.alloc(100, "y"));
		expect(passed.closes()).toBe(1);
	});

	test("shows a page that goes quiet as far as its pieces were read once the bound passes, and keeps no body of it", async () => {
		const started = Date.now();
		const arrived = Buffer.concat([Buffer.from("<html><body>Loading"), Buffer.alloc(READ_CHUNK_BYTES + 10, "l")]);
		const passed = await pass(paused(200), [arrived, "quiet"], { limits: { maxBytes: 1024 * 1024, timeoutMs: 150 } });

		expect(Date.now() - started).toBeLessThan(1_000);
		expect(passed.answers[0]!.body).toBeUndefined();
		expect(passed.fulfilledBody).toEqual(arrived.subarray(0, READ_CHUNK_BYTES));
		expect(passed.methods.slice(-3)).toEqual(["IO.close", "record", "Fetch.fulfillRequest"]);
	});

	test("answers an empty page as empty and keeps no body", async () => {
		const passed = await pass(paused(200), []);

		expect(passed.answers[0]!.body).toBeUndefined();
		expect(passed.fulfilledBody).toEqual(Buffer.alloc(0));
	});

	test("lets a page whose body cannot be taken go on as it came", async () => {
		const passed = await pass(paused(200), [Buffer.from("page")], { untakeable: true });

		expect(passed.methods).toEqual(["Fetch.takeResponseBodyAsStream", "record", "Fetch.continueRequest"]);
		expect(passed.answers[0]!.body).toBeUndefined();
	});

	test("stops holding only once the body being read is answered", async () => {
		const held = streamingSession([Buffer.from("<html>"), "quiet"]);
		const stop = await interceptDocumentAnswers(held.session, MAIN, () => undefined, { userAgent: "Mozilla/5.0 Test", platform: "MacIntel" }, { maxBytes: 100, timeoutMs: 150 });
		held.emit("Fetch.requestPaused", paused(200));

		await stop();

		expect(held.commands.map(({ method }) => method)).toEqual([
			"Emulation.setUserAgentOverride", "Fetch.enable",
			"Fetch.takeResponseBodyAsStream", "IO.read", "IO.close", "Fetch.fulfillRequest",
			"Fetch.disable", "detach",
		]);
	});
});

function* take<T>(items: Iterable<T>, count: number): Generator<T> {
	for (const item of items) {
		if (count-- <= 0) return;
		yield item;
	}
}

describe.skipIf(!chromiumAvailable)("holding a tab's documents, in a real browser", () => {
	const page = `<!DOCTYPE html><html><head><title>Kit</title></head><body><h1>Sign in</h1><p id="cookies"></p><script>document.getElementById("cookies").textContent = document.cookie;</script></body></html>`;
	const latin1 = Buffer.concat([Buffer.from("<html><body>caf"), Buffer.from([0xe9, 0xff, 0x80]), Buffer.from("</body></html>")]);
	const cancelled: string[] = [];
	/** A body that arrives in `chunks` and then, unless `close`, never ends: more pieces or nothing at all. */
	const streamed = (name: string, chunks: string[], after: "close" | "quiet" | "endless") => {
		let sent = 0;
		return new Response(new ReadableStream({
			pull: async (controller) => {
				if (sent < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[sent++]!));
				else if (after === "close") controller.close();
				else if (after === "endless") controller.enqueue(new TextEncoder().encode(`<p>${"y".repeat(16_384)}</p>`));
				else await new Promise(() => undefined);
			},
			cancel: () => { cancelled.push(name); },
		}), { headers: { "content-type": "text/html" } });
	};
	const CAP = 50_000;
	let server: ReturnType<typeof Bun.serve>;
	let browser: Browser;
	beforeAll(async () => {
		server = Bun.serve({
			port: 0,
			fetch: (request) => {
				const { pathname } = new URL(request.url);
				if (pathname === "/page") {
					const headers = new Headers({ "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
					headers.append("set-cookie", "session=abc; Path=/");
					headers.append("set-cookie", "kit=2; Path=/");
					return new Response(gzipSync(page), { headers });
				}
				if (pathname === "/latin1") return new Response(latin1, { headers: { "content-type": "text/html; charset=iso-8859-1" } });
				if (pathname === "/exact") return streamed("exact", ["<html>", "a".repeat(CAP - 6)], "close");
				if (pathname === "/over") return streamed("over", ["<html>", "a".repeat(CAP - 5)], "close");
				// More than one piece of a read, then nothing: the piece still filling is held back by the browser.
				if (pathname === "/quiet") return streamed("quiet", [`<html><body><h1>Beginning</h1><p>${"b".repeat(READ_CHUNK_BYTES)}</p>`, "<p>tail</p>"], "quiet");
				if (pathname === "/endless") return streamed("endless", ["<html><body><h1>Endless</h1>"], "endless");
				return new Response("missing", { status: 404 });
			},
		});
		browser = await launchTestChromium();
	});
	afterAll(async () => {
		await browser?.close();
		server?.stop(true);
	});

	/** Open `path` in a tab of a fresh profile whose documents are held, and return what the tab shows and what was recorded. */
	async function visit(path: string, bodyLimits = { maxBytes: CAP, timeoutMs: 1_000 }) {
		const context = await browser.createBrowserContext();
		const tab = await context.newPage();
		try {
			const answers: DocumentAnswer[] = [];
			const stop = await interceptDocumentAnswers(await tab.target().createCDPSession(), targetIdOf(tab.target()), (answer) => answers.push(answer), { userAgent: await browser.userAgent() }, bodyLimits);
			const started = Date.now();
			const response = await tab.goto(`http://127.0.0.1:${server.port}${path}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
			const elapsed = Date.now() - started;
			const shown = await tab.evaluate(() => document.documentElement.outerHTML);
			await stop();
			return { answers, shown, elapsed, status: response?.status(), headers: response?.headers() ?? {} };
		} finally {
			await context.close();
		}
	}

	test("a page shows what it shows unheld, keeps its cookies, and is kept as decoded", async () => {
		const context = await browser.createBrowserContext();
		const tab = await context.newPage();
		await tab.goto(`http://127.0.0.1:${server.port}/page`);
		const unheld = await tab.evaluate(() => document.documentElement.outerHTML);
		await context.close();

		const held = await visit("/page");

		expect(held.shown).toBe(unheld);
		expect(held.shown).toContain("session=abc; kit=2");
		expect(held.status).toBe(200);
		expect(held.headers["content-type"]).toBe("text/html; charset=utf-8");
		expect(held.answers).toEqual([{ url: `http://127.0.0.1:${server.port}/page`, status: 200, receivedAt: expect.any(String), body: Buffer.from(page) }]);
	}, 30_000);

	test("a page that is not UTF-8 is kept byte for byte", async () => {
		const held = await visit("/latin1");

		expect(held.answers[0]!.body).toEqual(latin1);
		expect(held.shown).toContain("café");
	}, 30_000);

	test("a page exactly at the cap is kept; one a byte over is shown up to the cap and not kept", async () => {
		const exact = await visit("/exact");
		expect(exact.answers[0]!.body?.byteLength).toBe(CAP);

		const over = await visit("/over");
		expect(over.answers).toEqual([{ url: `http://127.0.0.1:${server.port}/over`, status: 200, receivedAt: expect.any(String) }]);
		expect(over.shown).toContain("a".repeat(CAP - 6));
		expect(over.shown).not.toContain("a".repeat(CAP - 5));
	}, 30_000);

	test("a page that never ends is shown as far as the cap, without waiting on it, and its stream is let go", async () => {
		const endless = await visit("/endless", { maxBytes: CAP, timeoutMs: 10_000 });

		expect(endless.elapsed).toBeLessThan(5_000);
		expect(endless.answers[0]!.body).toBeUndefined();
		expect(endless.shown).toContain("<h1>Endless</h1>");
		await Bun.sleep(200);
		expect(cancelled).toContain("endless");
	}, 30_000);

	test("a page that goes quiet is shown as far as it arrived once the bound passes, and its stream is let go", async () => {
		const quiet = await visit("/quiet", { maxBytes: DOCUMENT_BODY_LIMITS.maxBytes, timeoutMs: 1_000 });
		expect(quiet.elapsed).toBeGreaterThanOrEqual(1_000);
		expect(quiet.elapsed).toBeLessThan(4_000);
		expect(quiet.answers[0]!.body).toBeUndefined();
		expect(quiet.shown).toContain("<h1>Beginning</h1>");
		expect(quiet.shown).not.toContain("tail");
		await Bun.sleep(200);
		expect(cancelled).toContain("quiet");
	}, 30_000);
});
