import { describe, expect, test } from "bun:test";

import type { FabricEgress } from "../browser/fabric";
import { ExfiltrationProbeExhaustedError, ExfiltrationProbeBudgetError, runExfiltrationProbe } from "./probe";
import type { ExfiltrationCanaries } from "./types";

const canaries: ExfiltrationCanaries = { marker: "psprobe_budget0", email: "probe.budget0@probe-canary.invalid", password: "A9!psprobe_budget0!qZ", phone: "+12125550100", cardNumber: "4242424242424242", oneTimeCode: "123456" };
const input = { reportId: 1n, submissionId: 2n, pageUrl: "https://phish.example/", reporter: {} };

describe("investigation budget expiry", () => {
	test("a budget that elapses mid-route is a terminal, non-retryable outcome, never a retry", async () => {
		const bindings: FabricEgress[] = [];
		const error = await runExfiltrationProbe(input, {
			createTask: async () => ({ runId: "run-phishing", response: {} }),
			// The Skyvern run never finishes; the budget is what ends it.
			getRun: async () => ({ status: "running" }),
			cancelRun: async () => undefined,
		}, undefined, {
			createCanaries: () => canaries,
			acquireBinding: async (egress) => { bindings.push(egress); return { sessionId: "browser-session_b", browserAddress: "ws://relay/b", release: async () => undefined, cancel: async () => undefined }; },
			connectBrowser: async () => ({ disconnect: () => undefined } as never),
			createRecorder: () => ({ start: async () => undefined, stop: async () => [] }),
			enrich: async (backend: unknown) => backend as never,
			report: async () => undefined,
			saveCapture: async () => undefined,
			heartbeat: async () => undefined,
			sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); },
			investigationBudgetMs: 25,
		}).then(() => undefined, (thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(ExfiltrationProbeBudgetError);
		expect((error as ExfiltrationProbeBudgetError).retryable).toBe(false);
		// The budget stops the walk: no later route is ever bound.
		expect(bindings).toEqual(["phishing"]);
		expect(error).not.toBeInstanceOf(ExfiltrationProbeExhaustedError);
	});

	test("a mid-route budget expiry cancels that route's Skyvern task and Fabric lease", async () => {
		let cancelledRun = 0;
		let cancelledLease = 0;
		await runExfiltrationProbe(input, {
			createTask: async () => ({ runId: "run-phishing", response: {} }),
			getRun: async () => ({ status: "running" }),
			cancelRun: async () => { cancelledRun++; },
		}, undefined, {
			createCanaries: () => canaries,
			acquireBinding: async () => ({ sessionId: "browser-session_b", browserAddress: "ws://relay/b", release: async () => undefined, cancel: async () => { cancelledLease++; } }),
			connectBrowser: async () => ({ disconnect: () => undefined } as never),
			createRecorder: () => ({ start: async () => undefined, stop: async () => [] }),
			enrich: async (backend: unknown) => backend as never,
			report: async () => undefined,
			saveCapture: async () => undefined,
			heartbeat: async () => undefined,
			sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); },
			investigationBudgetMs: 25,
		}).catch(() => undefined);
		expect(cancelledRun).toBe(1);
		expect(cancelledLease).toBe(1);
	});
});

describe("caller cancellation during an investigation", () => {
	test("a shutdown of the caller is an infrastructure stop, not a terminal budget verdict, so the job can retry", async () => {
		const shutdown = new AbortController();
		const error = await runExfiltrationProbe({ reportId: 1n, submissionId: 2n, pageUrl: "https://phish.example/", reporter: {} }, {
			createTask: async () => ({ runId: "run-phishing", response: {} }),
			getRun: async () => { shutdown.abort(new Error("Abuse worker is stopping.")); return { status: "running" }; },
			cancelRun: async () => undefined,
		}, shutdown.signal, {
			createCanaries: () => canaries,
			acquireBinding: async () => ({ sessionId: "browser-session_b", browserAddress: "ws://relay/b", release: async () => undefined, cancel: async () => undefined }),
			connectBrowser: async () => ({ disconnect: () => undefined } as never),
			createRecorder: () => ({ start: async () => undefined, stop: async () => [] }),
			enrich: async (backend: unknown) => backend as never,
			report: async () => undefined,
			saveCapture: async () => undefined,
			heartbeat: async () => undefined,
			sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); },
			investigationBudgetMs: 60_000,
		}).then(() => undefined, (thrown: unknown) => thrown);
		expect(error).not.toBeInstanceOf(ExfiltrationProbeBudgetError);
		expect((error as Error).message).toContain("Abuse worker is stopping");
	});
});
