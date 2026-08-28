import { describe, expect, test } from "bun:test";
import { resolveRegionalDns } from "./regional_dns";

function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("regional DNS evidence", () => {
	test("probes multiple countries and marks answers scoped to one country", async () => {
		const requests: string[] = [];
		const fetch = async (input: string, init?: RequestInit) => {
			requests.push(`${init?.method ?? "GET"} ${input}`);
			if (init?.method === "POST") return response({ id: "measurement-1" }, 202);
			return response({
				id: "measurement-1",
				status: "finished",
				results: [
					{ probe: { country: "BR", city: "Sao Paulo", network: "test" }, result: { statusCodeName: "NOERROR", statusCode: 0, answers: [{ value: "203.0.113.10", ttl: 60 }], timings: { total: 4 } } },
					{ probe: { country: "US", city: "New York", network: "test" }, result: { statusCodeName: "NXDOMAIN", statusCode: 3, answers: [], timings: { total: 8 } } },
					{ probe: { country: "DE", city: "Berlin", network: "test" }, result: { statusCodeName: "NXDOMAIN", statusCode: 3, answers: [], timings: { total: 7 } } },
				],
			});
		};

		const result = await resolveRegionalDns("shop.example.test", "A", { fetch, countries: ["br", "us", "de"], timeoutMs: 100, totalTimeoutMs: 500, retryDelayMs: 0 });
		expect(result.countries).toEqual(["BR", "US", "DE"]);
		expect(result.resolvedAddresses).toEqual(["203.0.113.10"]);
		expect(result.geographicallyScoped).toBe(true);
		expect(result.results.map((entry) => entry.country)).toEqual(["BR", "US", "DE"]);
		expect(requests).toEqual([
			"POST https://api.globalping.io/v1/measurements",
			"GET https://api.globalping.io/v1/measurements/measurement-1",
		]);
	});

	test("returns a bounded service error when a measurement never finishes", async () => {
		let polls = 0;
		const fetch = async (_input: string, init?: RequestInit) => {
			if (init?.method === "POST") return response({ id: "measurement-2" }, 202);
			polls++;
			return response({ id: "measurement-2", status: "in-progress", results: [] });
		};
		const result = await resolveRegionalDns("example.test", "A", { fetch, countries: ["US"], timeoutMs: 5, totalTimeoutMs: 20, pollAttempts: 100, retryDelayMs: 0 });
		expect(result.error).toContain("timed out");
		expect(polls).toBeGreaterThan(0);
	});
});
