import { describe, expect, test } from "bun:test";

import { OperationCanceledError, raceAbort } from "./cancellation";

describe("raceAbort", () => {
	test("without a signal it is the operation itself", async () => {
		await expect(raceAbort(Promise.resolve(1), undefined, () => { throw new Error("never"); })).resolves.toBe(1);
	});

	test("settles with the operation and never runs the cleanup when nothing aborts", async () => {
		let cleaned = 0;
		const controller = new AbortController();
		await expect(raceAbort(Promise.resolve("ok"), controller.signal, () => { cleaned++; })).resolves.toBe("ok");
		await expect(raceAbort(Promise.reject(new Error("boom")), controller.signal, () => { cleaned++; })).rejects.toThrow("boom");
		controller.abort();
		expect(cleaned).toBe(0);
	});

	test("an abort while the operation runs cancels it and runs the cleanup once", async () => {
		let cleaned = 0;
		const controller = new AbortController();
		const pending = raceAbort(new Promise<never>(() => undefined), controller.signal, () => { cleaned++; }, "stopped");
		controller.abort();
		controller.abort();
		await expect(pending).rejects.toEqual(new OperationCanceledError("stopped"));
		expect(cleaned).toBe(1);
	});

	test("an already aborted signal still runs the cleanup, so a resource the operation opens late is released", async () => {
		const controller = new AbortController();
		controller.abort();
		let cleaned = 0;
		await expect(raceAbort(Promise.resolve("late"), controller.signal, () => { cleaned++; }, "stopped")).rejects.toBeInstanceOf(OperationCanceledError);
		expect(cleaned).toBe(1);
		// Its rejection is observed, never unhandled.
		await expect(raceAbort(Promise.reject(new Error("late failure")), controller.signal)).rejects.toBeInstanceOf(OperationCanceledError);
	});

	test("a cleanup that throws does not keep the cancellation from settling", async () => {
		const controller = new AbortController();
		const pending = raceAbort(new Promise<never>(() => undefined), controller.signal, () => { throw new Error("cleanup"); });
		controller.abort();
		await expect(pending).rejects.toBeInstanceOf(OperationCanceledError);
	});
});
