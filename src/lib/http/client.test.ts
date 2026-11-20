import { afterEach, describe, expect, test } from "bun:test";

import { postJson } from "./client";

const realFetch = globalThis.fetch;
const answer = (response: Response | Error) => { globalThis.fetch = (async () => { if (response instanceof Error) throw response; return response; }) as unknown as typeof fetch; };
afterEach(() => { globalThis.fetch = realFetch; });

describe("postJson", () => {
	test("a success returns the body", async () => {
		answer(Response.json({ stream_id: "s1" }));
		expect(await postJson("/x", { a: 1 })).toEqual({ ok: true, data: { stream_id: "s1" } });
	});

	test("the route's own error text is what a failure says, whatever the status", async () => {
		answer(Response.json({ error: "Only failed analyses can be retried." }, { status: 409 }));
		expect(await postJson("/x", undefined, "Retry failed")).toEqual({ ok: false, error: "Only failed analyses can be retried." });
	});

	test("an answer without error text says what failed and its HTTP status", async () => {
		answer(new Response("<html>Bad gateway</html>", { status: 502 }));
		expect(await postJson("/x", undefined, "Retry failed")).toEqual({ ok: false, error: "Retry failed (502)" });
		answer(Response.json({ error: "" }, { status: 500 }));
		expect(await postJson("/x", undefined, "Retry failed")).toEqual({ ok: false, error: "Retry failed (500)" });
	});

	test("a request that got no answer says only what failed", async () => {
		answer(new TypeError("fetch failed"));
		expect(await postJson("/x", undefined, "Retry failed")).toEqual({ ok: false, error: "Retry failed" });
	});
});
