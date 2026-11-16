import { describe, expect, test } from "bun:test";

import { fetchEranetCorrespondence, type EranetFetch } from "./correspondence";

const RECEIPT = "900c40f7-944e-4944-a327-4b039439b8e4";

/** Eranet's record of the keychainagent.pro complaint as its portal returned it on 2026-11-16. */
function record(overrides: Record<string, unknown> = {}) {
	return {
		RequestId: "ddd9dc7c-a75d-4e14-9ae2-dcacd7cc91cc",
		Data: {
			id: 622,
			order_no: RECEIPT,
			type: 1,
			complaint_type: "phishing",
			email: "support@phishing.support",
			domain_info: [{ IDDomain: 17935790, Domain: "keychainagent.pro", Link: "https://keychainagent.pro/wksxgj/yX1fQWFGw9rp", Status: "ok" }],
			status: 5,
			review_remark: null,
			process_result: "The domain has been hold.",
			created_at: "2026-11-16 21:21:55",
			updated_at: "2026-11-16 21:24:23",
			reviewed_at: null,
			...overrides,
		},
	};
}

function portal(body: unknown, status = 200) {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fetch: EranetFetch = async (url, init) => { requests.push({ url, init }); return new Response(JSON.stringify(body), { status }); };
	return { fetch, requests };
}

describe("Eranet correspondence", () => {
	test("reads the complaint's review state and Eranet's outcome from its portal by receipt and our mailbox", async () => {
		const { fetch, requests } = portal(record());
		expect(await fetchEranetCorrespondence({ confirmationId: RECEIPT }, { fetch })).toEqual({
			messages: [],
			status: { state: "process completed", detail: "The domain has been hold." },
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]!.url).toBe("https://www.eranet.com/api/domain/abuse/DescribeInstanceByOrderNo");
		expect(requests[0]!.init).toMatchObject({ method: "POST", redirect: "error" });
		expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({ OrderNo: RECEIPT, Email: "support@phishing.support" });
	});

	test("names every review stage, and what Eranet asks for while it waits on us", async () => {
		const states: Array<[number, string]> = [[1, "submitted"], [2, "material auditing"], [3, "supplement required"], [4, "processing"], [5, "process completed"]];
		for (const [status, state] of states) {
			const result = await fetchEranetCorrespondence({ confirmationId: RECEIPT }, { fetch: portal(record({ status, process_result: null })).fetch });
			expect(result).toEqual({ messages: [], status: { state } });
		}
		const supplement = await fetchEranetCorrespondence({ confirmationId: RECEIPT }, { fetch: portal(record({ status: 3, process_result: "", review_remark: "Please provide a current screenshot." })).fetch });
		expect(supplement.status).toEqual({ state: "supplement required", detail: "Please provide a current screenshot." });
		// A stage Eranet adds later is not guessed at.
		expect(await fetchEranetCorrespondence({ confirmationId: RECEIPT }, { fetch: portal(record({ status: 9, process_result: null })).fetch })).toEqual({ messages: [] });
	});

	test("fails loudly on an unknown receipt, another complaint, or a broken answer, so the poll retries", async () => {
		await expect(fetchEranetCorrespondence({ confirmationId: RECEIPT }, { fetch: portal({ RequestId: "x", Data: null }).fetch })).rejects.toThrow("Eranet complaint lookup");
		await expect(fetchEranetCorrespondence({ confirmationId: RECEIPT }, { fetch: portal(record({ order_no: "another" })).fetch })).rejects.toThrow("another complaint");
		await expect(fetchEranetCorrespondence({ confirmationId: RECEIPT }, { fetch: portal(record(), 502).fetch })).rejects.toThrow("HTTP 502");
		await expect(fetchEranetCorrespondence({ confirmationId: RECEIPT }, { fetch: async () => new Response("<html>") })).rejects.toThrow("HTTP 200");
	});
});
