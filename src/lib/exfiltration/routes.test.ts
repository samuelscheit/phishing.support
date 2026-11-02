import { describe, expect, test } from "bun:test";

import { BrowserInfrastructureError, WebsiteUnreachableError } from "../website_archive";
import { probeRouteOutcome, PROBE_EGRESS_ORDER, runProbeRoutes, SkyvernPlanningLimitError } from "./routes";

describe("exfiltration probe egress order", () => {
	test("tries Tor, then the server IP, then the residential exit, matching capture's route concepts", () => {
		expect(PROBE_EGRESS_ORDER).toEqual(["phishing", "reporting", "residential"]);
	});
});

describe("probe route outcome classification", () => {
	test("a blocked or unreachable site advances to the next route", () => {
		expect(probeRouteOutcome(new WebsiteUnreachableError("phishing", "HTTP 403"))).toBe("next_route");
		expect(probeRouteOutcome(new WebsiteUnreachableError("reporting", "net::ERR_TIMED_OUT"))).toBe("next_route");
	});

	test("a Skyvern planning limit advances to the next route instead of ending the probe", () => {
		expect(probeRouteOutcome(new SkyvernPlanningLimitError("phishing", "150 planning iterations"))).toBe("next_route");
	});

	test("a browser-service failure is retryable infrastructure, never a route verdict", () => {
		expect(probeRouteOutcome(new BrowserInfrastructureError("Expected 101 status code"))).toBe("infrastructure");
	});

	test("an unexpected error is not swallowed as a site verdict", () => {
		expect(probeRouteOutcome(new Error("Skyvern returned an invalid run response."))).toBe("infrastructure");
	});
});

describe("runProbeRoutes", () => {
	test("stops at the first route that completes and never opens later routes", async () => {
		const attempted: string[] = [];
		const result = await runProbeRoutes({
			attempt: async (egress) => {
				attempted.push(egress);
				return { egress, value: "done" };
			},
		});
		expect(attempted).toEqual(["phishing"]);
		expect(result).toEqual({ outcome: "completed", egress: "phishing", value: "done" });
	});

	test("falls through every blocked route in order and records each outcome", async () => {
		const attempted: string[] = [];
		const result = await runProbeRoutes({
			attempt: async (egress) => {
				attempted.push(egress);
				if (egress === "residential") return { egress, value: "found" };
				throw new WebsiteUnreachableError(egress, "blocked");
			},
		});
		expect(attempted).toEqual(["phishing", "reporting", "residential"]);
		expect(result).toEqual({ outcome: "completed", egress: "residential", value: "found" });
	});

	test("exhausted routes with terminal route verdicts return a terminal outcome, not a retry", async () => {
		const result = await runProbeRoutes({
			attempt: async (egress) => {
				throw new WebsiteUnreachableError(egress, "blocked");
			},
		});
		expect(result).toMatchObject({ outcome: "exhausted" });
		if (result.outcome !== "exhausted") throw new Error("expected exhausted");
		expect(result.failures.map((failure) => failure.egress)).toEqual(["phishing", "reporting", "residential"]);
	});

	test("an infrastructure failure stops the walk and is rethrown so the job can retry it", async () => {
		const attempted: string[] = [];
		await expect(runProbeRoutes({
			attempt: async (egress) => {
				attempted.push(egress);
				throw new BrowserInfrastructureError("Expected 101 status code");
			},
		})).rejects.toThrow("Expected 101 status code");
		expect(attempted).toEqual(["phishing"]);
	});

	test("an unexpected error is rethrown rather than treated as a blocked route", async () => {
		const attempted: string[] = [];
		await expect(runProbeRoutes({
			attempt: async (egress) => {
				attempted.push(egress);
				throw new Error("Probe internal failure");
			},
		})).rejects.toThrow("Probe internal failure");
		expect(attempted).toEqual(["phishing"]);
	});
});

describe("investigation budget across routes", () => {
	test("a budget that is already spent starts no route at all", async () => {
		const attempted: string[] = [];
		const budget = new AbortController();
		budget.abort(new Error("Exfiltration investigation budget elapsed."));
		const result = await runProbeRoutes({
			budget: budget.signal,
			attempt: async (egress) => {
				attempted.push(egress);
				return { egress, value: "never" };
			},
		});
		expect(attempted).toEqual([]);
		expect(result).toEqual({ outcome: "exhausted", reason: "budget", failures: [] });
	});

	test("a budget that elapses during a route stops the walk before the next route", async () => {
		const attempted: string[] = [];
		const budget = new AbortController();
		const result = await runProbeRoutes({
			budget: budget.signal,
			attempt: async (egress) => {
				attempted.push(egress);
				budget.abort(new Error("Exfiltration investigation budget elapsed."));
				throw new WebsiteUnreachableError(egress, "blocked");
			},
		});
		expect(attempted).toEqual(["phishing"]);
		expect(result).toMatchObject({ outcome: "exhausted", reason: "budget" });
	});

	test("a budget abort is never a site verdict that advances the route", () => {
		expect(probeRouteOutcome(new Error("Exfiltration investigation budget elapsed."))).toBe("infrastructure");
	});
});
