import { describe, expect, test } from "bun:test";

import { runExfiltrationProbe } from "./probe";
import type { ExfiltrationCanaries } from "./types";

const canaries: ExfiltrationCanaries = { marker: "psprobe_x", email: "audit+psprobe_x@example.com", password: "A9!psprobe_x!", phone: "+15550000000", cardNumber: "1234567890123452", oneTimeCode: "123456" };

describe("durable exfiltration probe operation", () => {
	test("attaches the recorder before Skyvern, persists capture, and reports every confirmed backend", async () => {
		const order: string[] = [];
		const reported: string[] = [];
		let released = 0;
		const result = await runExfiltrationProbe(
			{ reportId: 1n, submissionId: 2n, pageUrl: "https://phish.example/", reporter: {} },
			{
				createTask: async () => { order.push("skyvern"); return { runId: "run-1", response: {} }; },
				getRun: async () => ({ status: "completed" }),
				cancelRun: async () => undefined,
			},
			undefined,
			{
				createCanaries: () => canaries,
				acquireBinding: async () => ({ sessionId: "browser-session_1", browserAddress: "ws://relay/session", release: async () => { released++; }, cancel: async () => undefined }),
				connectBrowser: async () => ({ disconnect: () => undefined } as never),
				createRecorder: () => ({
					start: async () => { order.push("recorder"); },
					stop: async () => [{ timestamp: "now", method: "POST", url: "https://collector.example/submit", postData: canaries.email }],
				}),
				enrich: async (backend) => backend,
				report: async ({ backend }) => { reported.push(backend.key); },
				saveCapture: async () => undefined,
				heartbeat: async () => undefined,
				sleep: async () => undefined,
			},
		);
		expect(order).toEqual(["recorder", "skyvern"]);
		expect(reported).toEqual(["domain:collector.example"]);
		expect(result).toEqual({ requests: 1, backends: 1 });
		expect(released).toBe(1);
	});

	test("cancels both Skyvern and Fabric when the task fails", async () => {
		let canceledRun = 0;
		let canceledBinding = 0;
		await expect(runExfiltrationProbe(
			{ reportId: 1n, submissionId: 2n, pageUrl: "https://phish.example/", reporter: {} },
			{ createTask: async () => ({ runId: "run-1", response: {} }), getRun: async () => ({ status: "failed" }), cancelRun: async () => { canceledRun++; } },
			undefined,
			{
				createCanaries: () => canaries,
				acquireBinding: async () => ({ sessionId: "browser-session_1", browserAddress: "ws://relay/session", release: async () => undefined, cancel: async () => { canceledBinding++; } }),
				connectBrowser: async () => ({ disconnect: () => undefined } as never),
				createRecorder: () => ({ start: async () => undefined, stop: async () => [] }),
				heartbeat: async () => undefined,
				sleep: async () => undefined,
			},
		)).rejects.toThrow("ended in failed");
		expect(canceledRun).toBe(1);
		expect(canceledBinding).toBe(1);
	});
});
