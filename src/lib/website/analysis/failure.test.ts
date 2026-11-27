import { describe, expect, test } from "bun:test";

import { BrowserInfrastructureError } from "../archive/errors";
import { withBrowserBackoff } from "./failure";

const browserFailure = () => new BrowserInfrastructureError("Protocol error: Target closed");

describe("withBrowserBackoff", () => {
	test("retries a browser-service failure after each delay, then succeeds", async () => {
		let attempts = 0;
		const result = await withBrowserBackoff(async () => {
			attempts++;
			if (attempts < 3) throw browserFailure();
			return "captured";
		}, [1, 1, 1]);
		expect(result).toBe("captured");
		expect(attempts).toBe(3);
	});

	test("throws the last failure once the delays are spent, and never retries a site failure", async () => {
		let attempts = 0;
		await expect(withBrowserBackoff(async () => { attempts++; throw browserFailure(); }, [1, 1])).rejects.toThrow("Target closed");
		expect(attempts).toBe(3);
		attempts = 0;
		await expect(withBrowserBackoff(async () => { attempts++; throw new Error("net::ERR_NAME_NOT_RESOLVED"); }, [1, 1])).rejects.toThrow("ERR_NAME_NOT_RESOLVED");
		expect(attempts).toBe(1);
	});

	test("an aborted signal runs no attempt at all", async () => {
		const reason = new Error("job timed out");
		let attempts = 0;
		await expect(withBrowserBackoff(async () => { attempts++; return "never"; }, [1], AbortSignal.abort(reason))).rejects.toBe(reason);
		expect(attempts).toBe(0);
	});

	test("an abort during a failing attempt ends it with the abort's reason instead of a retry", async () => {
		const controller = new AbortController();
		const reason = new Error("worker stopping");
		let attempts = 0;
		await expect(withBrowserBackoff(async () => {
			attempts++;
			controller.abort(reason);
			throw browserFailure();
		}, [1, 1], controller.signal)).rejects.toBe(reason);
		expect(attempts).toBe(1);
	});

	test("an abort during the wait between attempts ends the wait at once", async () => {
		const controller = new AbortController();
		const reason = new Error("job timed out");
		let attempts = 0;
		const started = Date.now();
		const run = withBrowserBackoff(async () => { attempts++; throw browserFailure(); }, [60_000], controller.signal);
		setTimeout(() => controller.abort(reason), 20);
		await expect(run).rejects.toBe(reason);
		expect(attempts).toBe(1);
		expect(Date.now() - started).toBeLessThan(5_000);
	});
});
