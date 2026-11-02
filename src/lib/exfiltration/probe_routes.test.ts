import { describe, expect, test } from "bun:test";

import type { FabricEgress } from "../browser/fabric";
import { WebsiteUnreachableError } from "../website_archive";
import { ExfiltrationProbeExhaustedError, runExfiltrationProbe } from "./probe";
import { SkyvernPlanningLimitError } from "./routes";
import type { ExfiltrationCanaries } from "./types";

const canaries: ExfiltrationCanaries = {
	marker: "psprobe_0123456789abcdef",
	email: "probe.0123456789abcdef@probe-canary.invalid",
	password: "A9!psprobe_0123456789abcdef!qZ",
	phone: "+15550100123",
	cardNumber: "4242424242424242",
	oneTimeCode: "123456",
};

const input = { reportId: 1n, submissionId: 2n, pageUrl: "https://phish.example/", reporter: {} };

/** A scripted Skyvern run: each attempt on a route ends in the given status and failure reason. */
function scriptedRoutes(outcomes: Partial<Record<FabricEgress, { status: string; failureReason?: string }>>) {
	const bindings: FabricEgress[] = [];
	const cancelled: string[] = [];
	const createdOn: string[] = [];
	return {
		bindings,
		cancelled,
		createdOn,
		dependencies: {
			createCanaries: () => canaries,
			acquireBinding: async (egress: FabricEgress) => {
				bindings.push(egress);
				return { sessionId: `browser-session_${egress}`, browserAddress: `ws://relay/${egress}`, release: async () => undefined, cancel: async () => { cancelled.push(egress); } };
			},
			connectBrowser: async () => ({ disconnect: () => undefined } as never),
			createRecorder: () => ({ start: async () => undefined, stop: async () => [] }),
			enrich: async (backend: unknown) => backend as never,
			report: async () => undefined,
			saveCapture: async () => undefined,
			heartbeat: async () => undefined,
			sleep: async () => undefined,
		},
		adapter: {
			createTask: async (_payload: unknown, options?: { browserAddress: string }) => {
				const egress = options?.browserAddress.replace("ws://relay/", "") as FabricEgress;
				createdOn.push(egress);
				return { runId: `run-${egress}`, response: {} };
			},
			getRun: async (runId: string) => {
				const egress = runId.replace("run-", "") as FabricEgress;
				const outcome = outcomes[egress] ?? { status: "completed" };
				return { status: outcome.status, failure_reason: outcome.failureReason };
			},
			cancelRun: async () => undefined,
		},
	};
}

describe("exfiltration probe route walk", () => {
	test("binds every attempt to its own route, in Tor, server IP, residential order", async () => {
		const routes = scriptedRoutes({ phishing: { status: "failed", failureReason: "HTTP 403 Forbidden blocked" }, reporting: { status: "terminated", failureReason: "net::ERR_TIMED_OUT" } });
		const result = await runExfiltrationProbe(input, routes.adapter, undefined, routes.dependencies);
		expect(routes.bindings).toEqual(["phishing", "reporting", "residential"]);
		expect(routes.createdOn).toEqual(["phishing", "reporting", "residential"]);
		expect(result).toEqual({ requests: 0, backends: [], downloads: [], egress: "residential" });
	});

	test("stops at the first route that completes; later routes are never bound", async () => {
		const routes = scriptedRoutes({});
		const result = await runExfiltrationProbe(input, routes.adapter, undefined, routes.dependencies);
		expect(routes.bindings).toEqual(["phishing"]);
		expect(result).toMatchObject({ egress: "phishing" });
	});

	test("a Skyvern planning limit on one route falls through to the next route", async () => {
		const routes = scriptedRoutes({ phishing: { status: "failed", failureReason: "150 planning iterations reached" } });
		const result = await runExfiltrationProbe(input, routes.adapter, undefined, routes.dependencies);
		expect(routes.bindings).toEqual(["phishing", "reporting"]);
		expect(result).toMatchObject({ egress: "reporting" });
	});

	test("a failed route releases its own binding (cancel) before the next route starts", async () => {
		const routes = scriptedRoutes({ phishing: { status: "terminated", failureReason: "blocked by site" } });
		await runExfiltrationProbe(input, routes.adapter, undefined, routes.dependencies);
		expect(routes.cancelled).toContain("phishing");
		expect(routes.bindings.indexOf("reporting")).toBeGreaterThan(-1);
	});

	test("exhausted routes end in a terminal, non-retryable error that names every route", async () => {
		const routes = scriptedRoutes({
			phishing: { status: "terminated", failureReason: "blocked by site" },
			reporting: { status: "timed_out", failureReason: "navigation timed out" },
			residential: { status: "failed", failureReason: "HTTP 503 unavailable" },
		});
		const error = await runExfiltrationProbe(input, routes.adapter, undefined, routes.dependencies).then(() => undefined, (thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(ExfiltrationProbeExhaustedError);
		expect((error as ExfiltrationProbeExhaustedError).retryable).toBe(false);
		expect((error as Error).message).toContain("phishing");
		expect((error as Error).message).toContain("reporting");
		expect((error as Error).message).toContain("residential");
	});

	test("an unrecognized Skyvern failure is infrastructure: it is rethrown, not walked to the next route", async () => {
		const routes = scriptedRoutes({ phishing: { status: "failed", failureReason: "agent crashed unexpectedly" } });
		const error = await runExfiltrationProbe(input, routes.adapter, undefined, routes.dependencies).then(() => undefined, (thrown: unknown) => thrown);
		expect(error).not.toBeInstanceOf(ExfiltrationProbeExhaustedError);
		expect((error as Error).message).toContain("ended in failed");
		expect(routes.bindings).toEqual(["phishing"]);
	});

});

