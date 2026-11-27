import { describe, expect, test } from "bun:test";

import { abortable, isAbortError } from "./abort";
import { errorChain } from "./error_chain";

describe("errorChain", () => {
	test("lists the error and its Error causes, and ends at a cycle or a non-Error cause", () => {
		const root = new Error("root");
		const outer = new Error("outer", { cause: new Error("middle", { cause: root }) });
		expect(errorChain(outer).map((error) => error.message)).toEqual(["outer", "middle", "root"]);
		expect(errorChain(new Error("a", { cause: "text" })).map((error) => error.message)).toEqual(["a"]);
		const a = new Error("a");
		a.cause = new Error("b", { cause: a });
		expect(errorChain(a)).toHaveLength(2);
		for (const value of [undefined, null, "AbortError", { name: "AbortError" }]) expect(errorChain(value)).toEqual([]);
	});
});

describe("isAbortError", () => {
	test("recognizes aborts and elapsed timeouts through any wrapper, and nothing else", async () => {
		expect(isAbortError(new DOMException("aborted", "AbortError"))).toBeTrue();
		expect(isAbortError(new DOMException("timed out", "TimeoutError"))).toBeTrue();
		const signal = AbortSignal.timeout(1);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(isAbortError(signal.reason)).toBeTrue();
		expect(isAbortError(AbortSignal.abort().reason)).toBeTrue();
		expect(isAbortError(new Error("capture failed", { cause: new DOMException("aborted", "AbortError") }))).toBeTrue();
		for (const value of [new Error("AbortError"), new Error("net::ERR_ABORTED"), "AbortError", undefined, null]) expect(isAbortError(value)).toBeFalse();
	});
});

describe("abortable", () => {
	test("passes the promise's own outcome through when the signal never aborts", async () => {
		const controller = new AbortController();
		expect(await abortable(Promise.resolve(42), controller.signal)).toBe(42);
		const failure = new Error("failed");
		await expect(abortable(Promise.reject(failure), controller.signal)).rejects.toBe(failure);
		expect(await abortable(Promise.resolve("no signal"), undefined)).toBe("no signal");
	});

	test("rejects with the reason at the abort, and hands a value that arrives later to discard", async () => {
		const controller = new AbortController();
		let resolve!: (value: string) => void;
		const discarded: string[] = [];
		const raced = abortable(new Promise<string>((done) => { resolve = done; }), controller.signal, (late) => { discarded.push(late); });
		const reason = new Error("stopped");
		controller.abort(reason);
		await expect(raced).rejects.toBe(reason);
		resolve("session");
		await new Promise((done) => setTimeout(done, 0));
		expect(discarded).toEqual(["session"]);
	});

	test("an already aborted signal rejects at once; a late failure or a failing discard is swallowed", async () => {
		const reason = new Error("gone");
		let reject!: (error: Error) => void;
		await expect(abortable(new Promise<string>((_, fail) => { reject = fail; }), AbortSignal.abort(reason))).rejects.toBe(reason);
		reject(new Error("late failure"));
		await expect(abortable(Promise.resolve(1), AbortSignal.abort(reason), () => { throw new Error("discard failed"); })).rejects.toBe(reason);
		await new Promise((done) => setTimeout(done, 0));
	});

	test("an abort after the value arrived changes nothing", async () => {
		const controller = new AbortController();
		const discarded: number[] = [];
		expect(await abortable(Promise.resolve(7), controller.signal, (late) => { discarded.push(late); })).toBe(7);
		controller.abort();
		await new Promise((done) => setTimeout(done, 0));
		expect(discarded).toEqual([]);
	});
});
