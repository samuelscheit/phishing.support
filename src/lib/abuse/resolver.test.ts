import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { parseExplicitWhoisAbuseMailboxes, resolveAbuseTarget, type ResolverDependencies } from "./resolver";

const originalGenericEmail = process.env.ABUSE_GENERIC_EMAIL_ENABLED;

beforeEach(() => {
	process.env.ABUSE_GENERIC_EMAIL_ENABLED = "true";
});

afterAll(() => {
	if (originalGenericEmail === undefined) delete process.env.ABUSE_GENERIC_EMAIL_ENABLED;
	else process.env.ABUSE_GENERIC_EMAIL_ENABLED = originalGenericEmail;
});

function rdapResponse(payload: Record<string, unknown>): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "content-type": "application/rdap+json" },
	});
}

function resolverWith(
	routes: Record<string, Record<string, unknown>>,
	port43: (server: string, query: string) => Promise<string> = async () => "",
): ResolverDependencies {
	return {
		assertPublicHost: async () => undefined,
		port43Query: async (server, query) => port43(server, query),
		fetch: async (input) => {
			const key = String(input);
			const payload = routes[key];
			if (!payload) return new Response(null, { status: 404 });
			return rdapResponse(payload);
		},
	};
}

function abuseEntity(email: string, handle = "ABUSE") {
	return {
		handle,
		roles: ["abuse"],
		vcardArray: ["vcard", [["email", {}, "text", email]]],
	};
}

describe("standalone abuse resolver", () => {
	test("uses only an explicit registrar abuse RDAP entity and excludes nearby technical contacts", async () => {
		const result = await resolveAbuseTarget(
			{ normalizedTarget: "example.com", targetType: "domain", observedUrls: [] },
			resolverWith({
				"https://rdap.org/domain/example.com": {
					port43: "whois.example.net",
					entities: [
						{
							handle: "REGISTRAR",
							roles: ["registrar"],
							publicIds: [{ type: "IANA Registrar ID", identifier: "999" }],
							entities: [
								{ roles: ["technical"], vcardArray: ["vcard", [["email", {}, "text", "technical@example.com"]]] },
								abuseEntity("abuse@example.com", "REGISTRAR-ABUSE"),
							],
						},
					],
				},
			}),
		);

		expect(result.status).toBe("resolved");
		expect(result.routes).toHaveLength(1);
		expect(result.routes[0]).toMatchObject({ routeType: "email", verifiedEmail: "abuse@example.com", status: "verified" });
		expect(result.routes.map((route) => route.verifiedEmail)).not.toContain("technical@example.com");
		expect(result.routes[0]?.resolverProvenance).toMatchObject({ email: "abuse@example.com" });
	});

	test("falls back to authoritative port-43 abuse-mailbox data when RDAP has no explicit abuse role", async () => {
		const queries: Array<[string, string]> = [];
		const result = await resolveAbuseTarget(
			{ normalizedTarget: "example.com", targetType: "domain", observedUrls: [] },
			resolverWith(
				{
					"https://rdap.org/domain/example.com": {
						port43: "whois.example.net",
						entities: [{ roles: ["registrar"], publicIds: [{ type: "IANA Registrar ID", identifier: "999" }], entities: [{ roles: ["technical"], email: "technical@example.com" }] }],
					},
				},
				async (server, query) => {
					queries.push([server, query]);
					return "Registrar Abuse Contact Email: abuse@example.com\nEmail: technical@example.com\n";
				},
			),
		);

		expect(queries).toEqual([["whois.example.net", "example.com"]]);
		expect(result.routes).toHaveLength(1);
		expect(result.routes[0]).toMatchObject({ verifiedEmail: "abuse@example.com", routeType: "email" });
		expect(parseExplicitWhoisAbuseMailboxes("Email: ignored@example.com\nabuse-mailbox: USE@EXAMPLE.COM\n")).toEqual(["use@example.com"]);
	});

	test("uses the BGP-origin ASN RDAP fallback and preserves independent IP/WHOIS/ASN provenance", async () => {
		const target = "154.201.78.249";
		const result = await resolveAbuseTarget(
			{ normalizedTarget: target, targetType: "ip", observedUrls: [] },
			resolverWith(
				{
					[`https://rdap.org/ip/${target}`]: {
						port43: "whois.example.net",
						name: "Allocation owner",
						entities: [{ roles: ["technical"], vcardArray: ["vcard", [["email", {}, "text", "noc@example.net"]]] }],
					},
					[`https://stat.ripe.net/data/network-info/data.json?resource=${target}`]: {
						data: { prefix: "154.201.78.0/24", asns: [402506] },
					},
					"https://rdap.org/autnum/402506": {
						handle: "AS402506",
						entities: [abuseEntity("abuse@tgtserver.com", "TGT-ABUSE")],
					},
				},
				async () => "netname: TGT-SERVER-NET\ndescr: Example network context\norg: TGT Server LLC\n",
			),
		);

		expect(result.status).toBe("resolved");
		expect(result.routes).toHaveLength(1);
		expect(result.routes[0]).toMatchObject({ verifiedEmail: "abuse@tgtserver.com", routeType: "email" });
		const snapshot = result.resolverSnapshot as Record<string, any>;
		expect(snapshot.port43Whois.networkMetadata).toMatchObject({ netname: "TGT-SERVER-NET", organization: "TGT Server LLC" });
		expect(snapshot.bgpOrigin).toMatchObject({ asns: [402506], prefix: "154.201.78.0/24" });
		expect(snapshot.asnRdap[0]).toMatchObject({ asn: 402506 });
	});

	test("keeps the allocation's explicit abuse contact ahead of WHOIS and BGP fallbacks", async () => {
		const target = "154.201.78.249";
		const requestedUrls: string[] = [];
		let port43Calls = 0;
		const result = await resolveAbuseTarget(
			{ normalizedTarget: target, targetType: "ip", observedUrls: [] },
			{
				assertPublicHost: async () => undefined,
				port43Query: async () => {
					port43Calls++;
					return "abuse-mailbox: whois@example.net";
				},
				fetch: async (input) => {
					const url = String(input);
					requestedUrls.push(url);
					if (url === `https://rdap.org/ip/${target}`) return rdapResponse({ entities: [abuseEntity("allocation@example.net")] });
					if (url === `https://stat.ripe.net/data/network-info/data.json?resource=${target}`) return rdapResponse({ data: { asns: [402506] } });
					if (url === "https://rdap.org/autnum/402506") return rdapResponse({ entities: [abuseEntity("asn@example.net")] });
					return new Response(null, { status: 404 });
				},
			},
		);

		expect(result.routes.map((route) => route.verifiedEmail)).toEqual(["allocation@example.net"]);
		expect(port43Calls).toBe(0);
		expect(requestedUrls).toEqual([
			`https://rdap.org/ip/${target}`,
			`https://stat.ripe.net/data/network-info/data.json?resource=${target}`,
			"https://rdap.org/autnum/402506",
		]);
	});

	test("does not fall through to BGP when the initial IP RDAP lookup is absent", async () => {
		const requestedUrls: string[] = [];
		const result = await resolveAbuseTarget(
			{ normalizedTarget: "154.201.78.249", targetType: "ip", observedUrls: [] },
			{
				assertPublicHost: async () => undefined,
				fetch: async (input) => {
					requestedUrls.push(String(input));
					return new Response(null, { status: 404 });
				},
			},
		);

		expect(result).toMatchObject({ status: "no_route", disposition: "no_verified_abuse_contact" });
		expect(result.routes[0]).toMatchObject({ routeType: "manual_unroutable", status: "no_route" });
		expect(requestedUrls).toEqual(["https://rdap.org/ip/154.201.78.249"]);
	});

});
