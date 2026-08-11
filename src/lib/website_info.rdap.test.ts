import { describe, expect, test } from "bun:test";

import { getAutnumRdapUrl, getIPRdapUrl, getRipeStatNetworkInfoUrl, queryRDAPDomain, queryRDAPIP } from "./website_info";

const xyzRdapResponse = {
	ldhName: "kinder2026.xyz",
	status: ["active"],
	events: [{ eventAction: "registration", eventDate: "2026-08-01T00:00:00Z" }],
	nameservers: [{ ldhName: "naomi.ns.cloudflare.com" }],
	entities: [
		{
			handle: "3956",
			roles: ["registrar"],
			vcardArray: [
				"vcard",
				[
					["version", {}, "text", "4.0"],
					["fn", {}, "text", "Global Domain Group LLC"],
				],
			],
			entities: [
				{
					handle: "not-applicable",
					roles: ["abuse"],
					vcardArray: [
						"vcard",
						[
							["version", {}, "text", "4.0"],
							["email", {}, "text", "abuse@globaldomaingroup.com"],
						],
					],
				},
			],
		},
	],
};

const cognetcloudIpRdapResponse = {
	objectClassName: "ip network",
	handle: "154.201.78.0 - 154.201.78.255",
	startAddress: "154.201.78.0",
	endAddress: "154.201.78.255",
	ipVersion: "v4",
	type: "ASSIGNED PA",
	country: "US",
	port43: "whois.afrinic.net",
	entities: [
		{
			handle: "CIS1-AFRINIC",
			roles: ["administrative", "technical"],
			vcardArray: [
				"vcard",
				[
					["version", {}, "text", "4.0"],
					["fn", {}, "text", "Cloud Innovation Support"],
					["email", {}, "text", "tech@cloudinnovation.org"],
				],
			],
		},
	],
};

const as402506RdapResponse = {
	objectClassName: "autnum",
	handle: "AS402506",
	name: "ZENIX",
	startAutnum: 402506,
	endAutnum: 402506,
	entities: [
		{
			handle: "ZENIX",
			roles: ["registrant"],
			entities: [
				{
					handle: "ANDER2359-ARIN",
					roles: ["administrative", "abuse", "technical"],
					vcardArray: [
						"vcard",
						[
							["version", {}, "text", "4.0"],
							["fn", {}, "text", "James Anderson"],
							["email", {}, "text", "abuse@tgtserver.com"],
						],
					],
				},
			],
		},
	],
};

describe("queryRDAPDomain", () => {
	test("uses the RDAP bootstrap resolver and preserves a .xyz registrar abuse contact", async () => {
		const requests: Array<{ input: string; init?: RequestInit }> = [];
		const fetchImplementation = async (input: string, init?: RequestInit) => {
			requests.push({ input, init });
			return new Response(JSON.stringify(xyzRdapResponse), { status: 200 });
		};

		const result = await queryRDAPDomain("kinder2026.xyz", fetchImplementation);

		expect(requests).toHaveLength(1);
		expect(String(requests[0].input)).toBe("https://rdap.org/domain/kinder2026.xyz");
		expect(requests[0].init?.redirect).toBe("follow");
		expect(new Headers(requests[0].init?.headers).get("accept")).toBe("application/rdap+json");
		expect(result?.domain).toBe("kinder2026.xyz");
		expect(result?.registrar?.abuse?.email).toBe("abuse@globaldomaingroup.com");
	});

	test("does not fabricate a registrar report target when the registry returns an error", async () => {
		const fetchImplementation = async () => new Response(null, { status: 404 });

		await expect(queryRDAPDomain("missing.xyz", fetchImplementation)).resolves.toBeUndefined();
	});
});

describe("queryRDAPIP", () => {
	test("enriches an IP with the BGP-origin ASN's explicit RDAP abuse contact", async () => {
		const ip = "154.201.78.249";
		const requests: Array<{ input: string; init?: RequestInit }> = [];
		const fetchImplementation = async (input: string, init?: RequestInit) => {
			requests.push({ input, init });
			switch (input) {
				case getIPRdapUrl(ip):
					return new Response(JSON.stringify(cognetcloudIpRdapResponse), { status: 200 });
				case getRipeStatNetworkInfoUrl(ip):
					return new Response(JSON.stringify({ data: { prefix: "154.201.78.0/23", asns: ["AS402506"] } }), { status: 200 });
				case getAutnumRdapUrl(402506):
					return new Response(JSON.stringify(as402506RdapResponse), { status: 200 });
				default:
					throw new Error(`Unexpected request: ${input}`);
			}
		};

		const result = await queryRDAPIP(ip, fetchImplementation);

		expect(requests.map((request) => request.input).sort()).toEqual(
			[getIPRdapUrl(ip), getRipeStatNetworkInfoUrl(ip), getAutnumRdapUrl(402506)].sort()
		);
		expect(result?.abuse).toBeNull();
		expect(result?.origin_asns).toEqual([
			{
				asn: 402506,
				prefix: "154.201.78.0/23",
				source: "ripe-stat",
				rdap: expect.objectContaining({
					handle: "AS402506",
					name: "ZENIX",
					abuse: expect.objectContaining({ email: "abuse@tgtserver.com" }),
				}),
			},
		]);
	});

	test("keeps the IP RDAP result when BGP-origin lookup is unavailable", async () => {
		const ip = "154.201.78.249";
		const fetchImplementation = async (input: string) => {
			if (input === getIPRdapUrl(ip)) return new Response(JSON.stringify(cognetcloudIpRdapResponse), { status: 200 });
			if (input === getRipeStatNetworkInfoUrl(ip)) return new Response(null, { status: 503 });
			throw new Error(`Unexpected request: ${input}`);
		};

		const result = await queryRDAPIP(ip, fetchImplementation);

		expect(result?.ip).toBe(ip);
		expect(result?.origin_asns).toEqual([]);
	});
});
