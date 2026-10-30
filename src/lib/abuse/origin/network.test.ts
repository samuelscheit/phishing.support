import { describe, expect, test } from "bun:test";

import { resolveOriginHostNetworks } from "./network";

function response(data: unknown) {
	return new Response(JSON.stringify({ status: "ok", data }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("origin host network attribution", () => {
	test("requires the exact disclosed mailbox and prioritizes the mail exchanger's ASN", async () => {
		const requests: string[] = [];
		const result = await resolveOriginHostNetworks("abusencc@interserver.net", undefined, {
			resolveMx: async () => [{ exchange: "mx.interserver.net", priority: 10 }],
			resolve4: async (host) => host.startsWith("mx.") ? ["66.23.231.189"] : ["104.20.17.90"],
			fetch: async (url) => {
				requests.push(url);
				const parsed = new URL(url);
				const endpoint = parsed.pathname.split("/").at(-2);
				const resource = parsed.searchParams.get("resource");
				if (endpoint === "searchcomplete") return response({ categories: [{ category: "ASNs", suggestions: [{ value: "AS26666" }, { value: "AS13335" }] }] });
				if (endpoint === "network-info") return response({ asns: resource === "66.23.231.189" ? ["19318"] : ["13335"], prefix: "ignored" });
				if (endpoint === "abuse-contact-finder") return response({ abuse_contacts: resource === "AS13335" ? ["abuse@cloudflare.com"] : ["abusencc@interserver.net"] });
				if (endpoint === "as-overview") return response({ holder: resource === "AS19318" ? "INTERSERVER, INC" : "INTERSERVER-LAX" });
				if (endpoint === "announced-prefixes") return response({ prefixes: [{ prefix: resource === "AS19318" ? "66.23.224.0/19" : "64.20.32.0/19" }] });
				throw new Error(`Unexpected ${url}`);
			},
		});

		expect(result.recipient).toBe("abusencc@interserver.net");
		expect(result.networks.map(({ asn }) => asn)).toEqual([19318, 26666]);
		expect(result.networks[0]).toMatchObject({
			holder: "INTERSERVER, INC",
			prefixes: ["66.23.224.0/19"],
			discoverySources: ["mail_exchanger_dns"],
		});
		expect(result.networks.some(({ asn }) => asn === 13335)).toBe(false);
		expect(requests.every((url) => new URL(url).hostname === "stat.ripe.net")).toBe(true);
	});

	test("fails closed on an invalid disclosed mailbox", async () => {
		await expect(resolveOriginHostNetworks("not a mailbox")).rejects.toThrow("invalid hosting-provider mailbox");
	});
});
