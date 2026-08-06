import { describe, expect, test } from "bun:test";

import { queryRDAPDomain } from "./website_info";

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
