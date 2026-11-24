import { describe, expect, test } from "bun:test";

import { parseExplicitWhoisAbuseMailboxes, resolveAbuseTarget, type ResolverDependencies } from "./";
import { testRdapLocator } from "../../network/rdap_test_helpers";

function rdapResponse(payload: Record<string, unknown>): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "content-type": "application/rdap+json" },
	});
}

function resolverWith(
	routes: Record<string, Record<string, unknown>>,
	port43: (server: string, query: string) => Promise<string> = async () => "",
	resolveDomainAddresses: (domain: string) => Promise<string[]> = async () => [],
): ResolverDependencies {
	return {
		assertPublicHost: async () => undefined,
		// Domain resolver tests exercise RDAP/WHOIS policy. Keep infrastructure
		// discovery explicit in the tests that need it rather than consulting the
		// workstation DNS resolver for every fixture domain.
		resolveDomainAddresses,
		port43Query: async (server, query) => port43(server, query),
		rdapLocator: testRdapLocator,
		fetch: async (input) => {
			const key = String(input);
			const payload = routes[key];
			if (!payload) return new Response(null, { status: 404 });
			return rdapResponse(payload);
		},
	};
}

const TATA_BGP_STATE = "https://stat.ripe.net/data/bgp-state/data.json?resource=14.194.136.0%2F21";

/** A RIPEstat bgp-state answer: one collector route per AS path, each for `prefix`. */
function bgpState(prefix: string, paths: number[][]) {
	return { data: { bgp_state: paths.map((path, index) => ({ target_prefix: prefix, source_id: `00-collector-${index}`, path })) } };
}

function abuseEntity(email: string, handle = "ABUSE") {
	return {
		handle,
		roles: ["abuse"],
		vcardArray: ["vcard", [["email", {}, "text", email]]],
	};
}

describe("abuse resolver", () => {
	test("uses only an explicit registrar abuse RDAP entity and excludes nearby technical contacts", async () => {
		const result = await resolveAbuseTarget(
			{ normalizedTarget: "example.com", targetType: "domain", observedUrls: [] },
			resolverWith({
				"https://rdap.test/domain/example.com": {
					port43: "whois.example.net",
					entities: [
						{
							handle: "REGISTRAR",
							roles: ["registrar"],
							publicIds: [{ type: "IANA Registrar ID", identifier: "999" }],
							entities: [
								{ roles: ["technical"], vcardArray: ["vcard", [["email", {}, "text", "technical@example-fixture.com"]]] },
								abuseEntity("abuse@example-fixture.com", "REGISTRAR-ABUSE"),
							],
						},
					],
				},
			}),
		);

		expect(result.status).toBe("resolved");
		expect(result.routes).toHaveLength(1);
		expect(result.routes[0]).toMatchObject({ routeType: "email", verifiedEmail: "abuse@example-fixture.com", status: "verified" });
		expect(result.routes.map((route) => route.verifiedEmail)).not.toContain("technical@example-fixture.com");
		expect(result.routes[0]?.resolverProvenance).toMatchObject({ email: "abuse@example-fixture.com" });
	});

	test("asks the registry for the registered domain of a host, which registries do not know by itself", async () => {
		// trustwallet.com-info.vip (2026-11-23): .vip's RDAP answers 404 for the
		// host, so its registrar West263 was never reported.
		const queries: Array<[string, string]> = [];
		const result = await resolveAbuseTarget(
			{ normalizedTarget: "trustwallet.com-info.vip", targetType: "domain", observedUrls: [] },
			resolverWith(
				{
					"https://rdap.test/domain/com-info.vip": {
						port43: "whois.example.net",
						entities: [{ handle: "1915", roles: ["registrar"], publicIds: [{ type: "IANA Registrar ID", identifier: "1915" }] }],
					},
				},
				async (server, query) => {
					queries.push([server, query]);
					return "Registrar Abuse Contact Email: abuse@hkdns.hk\n";
				},
			),
		);

		expect(queries).toEqual([["whois.example.net", "com-info.vip"]]);
		expect(result.status).toBe("resolved");
		expect(result.routes).toHaveLength(1);
		expect(result.routes[0]).toMatchObject({ routeType: "email", verifiedEmail: "abuse@hkdns.hk", providerDisplayName: "Abuse contact for com-info.vip" });
		expect(result.resolverSnapshot).toMatchObject({ target: "trustwallet.com-info.vip", registeredDomain: "com-info.vip" });
	});

	test("never reports a platform tenant to the registrar of the platform's own domain", async () => {
		const requested: string[] = [];
		const dependencies = resolverWith(
			{
				"https://rdap.test/domain/github.io": { entities: [abuseEntity("abuse@markmonitor.example", "REGISTRAR-ABUSE")] },
				"https://rdap.test/domain/amazonaws.com": { entities: [abuseEntity("abuse@markmonitor.example", "REGISTRAR-ABUSE")] },
			},
		);
		const fetch = dependencies.fetch!;
		dependencies.fetch = async (input, init) => {
			requested.push(String(input));
			return fetch(input, init);
		};

		for (const host of ["kit.github.io", "bucket.s3.amazonaws.com"]) {
			const result = await resolveAbuseTarget({ normalizedTarget: host, targetType: "domain", observedUrls: [] }, dependencies);
			expect(result).toMatchObject({ status: "no_route", disposition: "platform_tenant" });
			expect(result.routes.map((route) => route.verifiedEmail)).not.toContain("abuse@markmonitor.example");
		}
		expect(requested.filter((url) => url.includes("/domain/"))).toEqual([]);
	});

	test("falls back to authoritative port-43 abuse-mailbox data when RDAP has no explicit abuse role", async () => {
		const queries: Array<[string, string]> = [];
		const result = await resolveAbuseTarget(
			{ normalizedTarget: "example.com", targetType: "domain", observedUrls: [] },
			resolverWith(
				{
					"https://rdap.test/domain/example.com": {
						port43: "whois.example.net",
						entities: [{ roles: ["registrar"], publicIds: [{ type: "IANA Registrar ID", identifier: "999" }], entities: [{ roles: ["technical"], email: "technical@example-fixture.com" }] }],
					},
				},
				async (server, query) => {
					queries.push([server, query]);
					return "Registrar Abuse Contact Email: abuse@example-fixture.com\nEmail: technical@example-fixture.com\n";
				},
			),
		);

		expect(queries).toEqual([["whois.example.net", "example.com"]]);
		expect(result.routes).toHaveLength(1);
		expect(result.routes[0]).toMatchObject({ verifiedEmail: "abuse@example-fixture.com", routeType: "email" });
		expect(parseExplicitWhoisAbuseMailboxes("Email: ignored@example-fixture.com\nabuse-mailbox: USE@EXAMPLE-FIXTURE.COM\n")).toEqual(["use@example-fixture.com"]);
	});

	test("uses the BGP-origin ASN RDAP fallback and preserves independent IP/WHOIS/ASN provenance", async () => {
		const target = "154.201.78.249";
		const result = await resolveAbuseTarget(
			{ normalizedTarget: target, targetType: "ip", observedUrls: [] },
			resolverWith(
				{
					[`https://rdap.test/ip/${target}`]: {
						port43: "whois.example.net",
						name: "Allocation owner",
						entities: [{ roles: ["technical"], vcardArray: ["vcard", [["email", {}, "text", "noc@example-fixture.net"]]] }],
					},
					[`https://stat.ripe.net/data/network-info/data.json?resource=${target}`]: {
						data: { prefix: "154.201.78.0/24", asns: [402506] },
					},
					"https://rdap.test/autnum/402506": {
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
					return "abuse-mailbox: whois@example-fixture.net";
				},
				rdapLocator: testRdapLocator,
				fetch: async (input) => {
					const url = String(input);
					requestedUrls.push(url);
					if (url === `https://rdap.test/ip/${target}`) return rdapResponse({ entities: [abuseEntity("allocation@example-fixture.net")] });
					if (url === `https://stat.ripe.net/data/network-info/data.json?resource=${target}`) return rdapResponse({ data: { asns: [402506] } });
					if (url === "https://rdap.test/autnum/402506") return rdapResponse({ entities: [abuseEntity("asn@example-fixture.net")] });
					return new Response(null, { status: 404 });
				},
			},
		);

		expect(result.routes.map((route) => route.verifiedEmail)).toEqual(["allocation@example-fixture.net"]);
		expect(result.routes[0]?.resolverProvenance).toMatchObject({ email: "allocation@example-fixture.net", fallbackContacts: [{ email: "asn@example-fixture.net", source: "asn_rdap" }] });
		expect(port43Calls).toBe(0);
		expect(requestedUrls).toEqual([
			`https://rdap.test/ip/${target}`,
			`https://stat.ripe.net/data/network-info/data.json?resource=${target}`,
			"https://rdap.test/autnum/402506",
		]);
	});

	describe("an address's fallback contacts", () => {
		const target = "14.194.139.244";
		const DEAD = "ip.abuse@tatatel.co.in";
		/** The registry tree, origin and upstream of 14.194.139.244 as APNIC and RIPEstat published them on 2026-11-22. */
		function tataRecords(overrides: Record<string, Record<string, unknown> | undefined> = {}): Record<string, Record<string, unknown>> {
			const records: Record<string, Record<string, unknown> | undefined> = {
				[`https://rdap.test/ip/${target}`]: { handle: "14.194.128.0 - 14.194.191.255", startAddress: "14.194.128.0", endAddress: "14.194.191.255", entities: [abuseEntity(DEAD, "IRT-TATA-DOCOMO-IN")] },
				"https://rdap.test/ip/14.194.128.0/17": { handle: "14.194.0.0 - 14.195.255.255", startAddress: "14.194.0.0", endAddress: "14.195.255.255", entities: [abuseEntity(DEAD, "IRT-TATA-DOCOMO-IN")] },
				"https://rdap.test/ip/14.192.0.0/14": { handle: "14.0.0.0 - 14.255.255.255", startAddress: "14.0.0.0", endAddress: "14.255.255.255", entities: [abuseEntity("helpdesk@apnic.net", "IRT-APNIC-AP")] },
				[`https://stat.ripe.net/data/network-info/data.json?resource=${target}`]: { data: { asns: ["45820"], prefix: "14.194.136.0/21" } },
				"https://rdap.test/autnum/45820": { handle: "AS45820", name: "TTSL-ISP", entities: [abuseEntity(DEAD, "IRT-TTSLMEIS-IN"), { roles: ["registrant"], handle: "ORG-TD1-AP", vcardArray: ["vcard", [["fn", {}, "text", "TTSL-ISP DIVISION"]]] }] },
				[TATA_BGP_STATE]: bgpState("14.194.136.0/21", [
					[174, 6453, 4755, 45820],
					[3356, 4755, 4755, 45820, 45820],
					[6939, 4755, 45820],
					[2914, 9498, 45820],
				]),
				"https://rdap.test/autnum/4755": { handle: "AS4755", entities: [abuseEntity("4755abuse@tatacommunications.com", "IRT-TATACOMM-IN"), { roles: ["registrant"], vcardArray: ["vcard", [["fn", {}, "text", "Tata Communications Limited"]]] }] },
				...overrides,
			};
			return Object.fromEntries(Object.entries(records).filter((entry): entry is [string, Record<string, unknown>] => entry[1] !== undefined));
		}
		const resolve = (records: Record<string, Record<string, unknown>>) => resolveAbuseTarget({ normalizedTarget: target, targetType: "ip", observedUrls: [] }, resolverWith(records));

		test("14.194.139.244: every published contact is the dead mailbox, so the upstream transit provider is its one fallback", async () => {
			const result = await resolve(tataRecords());
			expect(result.status).toBe("resolved");
			expect(result.routes).toHaveLength(1);
			expect(result.routes[0]).toMatchObject({ verifiedEmail: DEAD, routeType: "email" });
			expect(result.routes[0]?.resolverProvenance).toMatchObject({ email: DEAD, source: "ip_rdap" });
			expect(result.routes[0]?.resolverProvenance.fallbackContacts).toEqual([{
				email: "4755abuse@tatacommunications.com",
				source: "upstream_asn_rdap",
				entityName: "IRT-TATACOMM-IN",
				organization: "Tata Communications Limited",
				transit: { upstreamAsn: 4755, customerAsn: 45820, customerOrganization: "TTSL-ISP DIVISION", customerPrefix: "14.194.136.0/21" },
			}]);
			const snapshot = result.resolverSnapshot as Record<string, any>;
			// The climb stops at APNIC's own 14.0.0.0/8, whose helpdesk is never a fallback.
			expect(snapshot.parentObjects.objects.map((object: { query: string }) => object.query)).toEqual(["14.194.128.0/17"]);
			expect(snapshot.upstreamTransit).toMatchObject([{ customerAsn: 45820, upstreamAsn: 4755 }]);
		});

		test("the mailbox a registry marks as the abuse mailbox comes before the entity's other emails", async () => {
			const result = await resolve(tataRecords({
				"https://rdap.test/autnum/4755": { entities: [{ roles: ["abuse"], handle: "IRT-TATACOMM-IN", vcardArray: ["vcard", [
					["email", {}, "text", "ip.admin@tatacommunications.com"],
					["email", { pref: "1" }, "text", "4755abuse@tatacommunications.com"],
					["email", { type: ["work", "Abuse"] }, "text", "typed@tatacommunications.com"],
				]] }] },
			}));
			expect((result.routes[0]!.resolverProvenance.fallbackContacts as Array<{ email: string }>).map((contact) => contact.email))
				.toEqual(["typed@tatacommunications.com", "4755abuse@tatacommunications.com", "ip.admin@tatacommunications.com"]);
		});

		test("orders distinct contacts allocation, parent, origin ASN, upstream", async () => {
			const result = await resolve(tataRecords({
				"https://rdap.test/ip/14.194.128.0/17": { startAddress: "14.194.0.0", endAddress: "14.195.255.255", entities: [abuseEntity("abuse@parent-fixture.net")] },
				"https://rdap.test/ip/14.192.0.0/14": { startAddress: "14.192.0.0", endAddress: "14.195.255.255", entities: [abuseEntity("abuse@grandparent-fixture.net"), abuseEntity("abuse@parent-fixture.net")] },
				"https://rdap.test/ip/14.192.0.0/13": { startAddress: "14.0.0.0", endAddress: "14.255.255.255", entities: [abuseEntity("helpdesk@apnic.net")] },
				"https://rdap.test/autnum/45820": { entities: [abuseEntity("abuse@origin-fixture.net")] },
			}));
			const provenance = result.routes[0]!.resolverProvenance;
			expect(provenance.email).toBe(DEAD);
			expect((provenance.fallbackContacts as Array<{ email: string }>).map((contact) => contact.email))
				.toEqual(["abuse@parent-fixture.net", "abuse@grandparent-fixture.net", "abuse@origin-fixture.net", "4755abuse@tatacommunications.com"]);
		});

		test("a server that does not answer less-specific queries, or answers with the same object, ends the climb", async () => {
			const notFound = await resolve(tataRecords({ "https://rdap.test/ip/14.194.128.0/17": undefined }));
			expect((notFound.resolverSnapshot as Record<string, any>).parentObjects).toEqual({ objects: [] });
			const same = await resolve(tataRecords({ "https://rdap.test/ip/14.194.128.0/17": { startAddress: "14.194.128.0", endAddress: "14.194.191.255", entities: [abuseEntity("abuse@loop-fixture.net")] } }));
			expect((same.resolverSnapshot as Record<string, any>).parentObjects).toEqual({ objects: [] });
			expect((same.routes[0]!.resolverProvenance.fallbackContacts as Array<{ email: string }>).map((contact) => contact.email)).not.toContain("abuse@loop-fixture.net");
		});

		test("reads at most four objects above the allocation", async () => {
			const records = tataRecords();
			// A tree that never reaches the registry: /15, /14, /13, /12, /11.
			const levels = [
				["14.194.128.0/17", "14.194.0.0", "14.195.255.255"],
				["14.192.0.0/14", "14.192.0.0", "14.195.255.255"],
				["14.192.0.0/13", "14.192.0.0", "14.199.255.255"],
				["14.192.0.0/12", "14.192.0.0", "14.207.255.255"],
				["14.192.0.0/11", "14.192.0.0", "14.223.255.255"],
			] as const;
			for (const [index, [query, start, end]] of levels.entries()) records[`https://rdap.test/ip/${query}`] = { startAddress: start, endAddress: end, entities: [abuseEntity(`abuse@level${index}-fixture.net`)] };
			const result = await resolve(records);
			expect((result.resolverSnapshot as Record<string, any>).parentObjects.objects).toHaveLength(4);
			expect((result.routes[0]!.resolverProvenance.fallbackContacts as Array<{ email: string }>).map((contact) => contact.email).slice(0, 4))
				.toEqual(["abuse@level0-fixture.net", "abuse@level1-fixture.net", "abuse@level2-fixture.net", "abuse@level3-fixture.net"]);
		});

		test("no upstream when RIPEstat holds no route for the prefix, only the origin's own, only other prefixes' or origins', no prefix, or its lookup fails", async () => {
			for (const state of [
				undefined,
				bgpState("14.194.136.0/21", []),
				bgpState("14.194.136.0/21", [[45820], [45820, 45820]]),
				bgpState("14.194.136.0/22", [[174, 4755, 45820]]),
				bgpState("14.194.136.0/21", [[174, 4755, 64500]]),
			]) {
				const result = await resolve(tataRecords({ [TATA_BGP_STATE]: state }));
				expect(result.routes[0]?.resolverProvenance).not.toHaveProperty("fallbackContacts");
			}
			const withoutPrefix = await resolve(tataRecords({ [`https://stat.ripe.net/data/network-info/data.json?resource=${target}`]: { data: { asns: ["45820"] } } }));
			expect(withoutPrefix.routes[0]?.resolverProvenance).not.toHaveProperty("fallbackContacts");
			const failing = await resolveAbuseTarget({ normalizedTarget: target, targetType: "ip", observedUrls: [] }, {
				...resolverWith(tataRecords()),
				httpRetryAttempts: 1,
				fetch: async (input) => String(input).includes("bgp-state") ? new Response(null, { status: 500 }) : resolverWith(tataRecords()).fetch!(input),
			});
			expect(failing.routes[0]).toMatchObject({ verifiedEmail: DEAD });
			expect((failing.resolverSnapshot as Record<string, any>).upstreamTransit[0].error).toBeString();
		});

		test("198.251.81.14: the upstream is the one carrying the address's own prefix, not the origin's best-connected neighbour", async () => {
			// FranTech (AS53667) reaches most of the Internet through Hurricane Electric (AS6939), but its
			// 198.251.81.0/24 only through Bytefilter (AS1002), as RIPEstat showed on 2026-11-23 (352 of 352 routes).
			const ip = "198.251.81.14";
			const records = {
				[`https://rdap.test/ip/${ip}`]: { startAddress: "198.251.80.0", endAddress: "198.251.95.255", entities: [abuseEntity("admin@frantech.ca", "FDI19-ARIN")] },
				[`https://stat.ripe.net/data/network-info/data.json?resource=${ip}`]: { data: { asns: ["53667"], prefix: "198.251.81.0/24" } },
				"https://rdap.test/autnum/53667": { entities: [abuseEntity("admin@frantech.ca", "FDI19-ARIN")] },
				"https://stat.ripe.net/data/bgp-state/data.json?resource=198.251.81.0%2F24": bgpState("198.251.81.0/24", [
					[328840, 327727, 174, 137409, 1002, 53667],
					[6939, 137409, 1002, 1002, 53667],
					[3356, 1002, 53667, 53667],
				]),
				"https://rdap.test/autnum/1002": { entities: [abuseEntity("noc@bytefilter.com", "NOC"), { roles: ["registrant"], vcardArray: ["vcard", [["fn", {}, "text", "Bytefilter LLC"]]] }] },
				"https://rdap.test/autnum/6939": { entities: [abuseEntity("abuse@he.net", "ABUSE1036-ARIN")] },
			};
			const result = await resolveAbuseTarget({ normalizedTarget: ip, targetType: "ip", observedUrls: [] }, resolverWith(records));
			expect(result.routes[0]?.resolverProvenance).toMatchObject({
				email: "admin@frantech.ca",
				fallbackContacts: [{ email: "noc@bytefilter.com", source: "upstream_asn_rdap", organization: "Bytefilter LLC", transit: { upstreamAsn: 1002, customerAsn: 53667, customerPrefix: "198.251.81.0/24" } }],
			});
			expect((result.resolverSnapshot as Record<string, any>).upstreamTransit).toMatchObject([{ customerAsn: 53667, upstreamAsn: 1002, routes: 3 }]);
		});

		test("an upstream publishing only a registry mailbox adds nothing", async () => {
			const result = await resolve(tataRecords({ "https://rdap.test/autnum/4755": { entities: [abuseEntity("abuse@ripe.net")] } }));
			expect(result.routes[0]?.resolverProvenance).not.toHaveProperty("fallbackContacts");
		});

		test("when the allocation publishes no contact, the first fallback becomes the route", async () => {
			const result = await resolve(tataRecords({
				[`https://rdap.test/ip/${target}`]: { startAddress: "14.194.128.0", endAddress: "14.194.191.255", entities: [] },
				"https://rdap.test/ip/14.194.128.0/17": { startAddress: "14.194.0.0", endAddress: "14.195.255.255", entities: [] },
				"https://rdap.test/autnum/45820": { entities: [] },
			}));
			expect(result.routes[0]).toMatchObject({ verifiedEmail: "4755abuse@tatacommunications.com" });
			expect(result.routes[0]?.resolverProvenance).toMatchObject({ source: "upstream_asn_rdap", transit: { customerAsn: 45820 } });
		});

		test("a hosting address's fallbacks belong to the domain's infrastructure route, beside its first contact", async () => {
			const result = await resolveAbuseTarget(
				{ normalizedTarget: "zealousvoice.com", targetType: "domain", observedUrls: [] },
				resolverWith({ ...tataRecords(), "https://rdap.test/domain/zealousvoice.com": { entities: [] } }, async () => "", async () => [target]),
			);
			const route = result.routes.find((candidate) => candidate.verifiedEmail === DEAD)!;
			expect(route.resolverProvenance).toMatchObject({
				source: "domain_infrastructure_ip",
				originatingIp: target,
				ipRouteProvenance: { email: DEAD, source: "ip_rdap" },
				fallbackContacts: [{ email: "4755abuse@tatacommunications.com" }],
			});
			expect(route.resolverProvenance.ipRouteProvenance).not.toHaveProperty("fallbackContacts");
		});
	});

	test("does not fall through to BGP when the initial IP RDAP lookup is absent", async () => {
		const requestedUrls: string[] = [];
		const result = await resolveAbuseTarget(
			{ normalizedTarget: "154.201.78.249", targetType: "ip", observedUrls: [] },
			{
				assertPublicHost: async () => undefined,
				rdapLocator: testRdapLocator,
				fetch: async (input) => {
					requestedUrls.push(String(input));
					return new Response(null, { status: 404 });
				},
			},
		);

		expect(result).toMatchObject({ status: "no_route", disposition: "no_verified_abuse_contact" });
		expect(result.routes[0]).toMatchObject({ routeType: "manual_unroutable", status: "no_route" });
		expect(requestedUrls).toEqual(["https://rdap.test/ip/154.201.78.249"]);
	});

	test("discovers exact direct-provider routes from public domain infrastructure and records ignored DNS answers", async () => {
		const target = "host.example.com";
		const cloudflareIp = "104.16.0.1";
		const tencentIp = "1.1.1.1";
		const result = await resolveAbuseTarget(
			{ normalizedTarget: target, targetType: "domain", observedUrls: [] },
			resolverWith(
				{
					[`https://rdap.test/domain/${target}`]: { entities: [] },
					[`https://rdap.test/ip/${cloudflareIp}`]: { entities: [abuseEntity("abuse@cloudflare.com")] },
					[`https://rdap.test/ip/${tencentIp}`]: { entities: [abuseEntity("dnsabuse_complaint@tencent.com")] },
				},
				async () => "",
				async () => [cloudflareIp, "10.0.0.1", tencentIp, "2001:db8::1", cloudflareIp],
			),
		);

		expect(result.status).toBe("resolved");
		expect(result.routes).toHaveLength(2);
		expect(result.routes.map((route) => route.providerRegistryKey)).toEqual(["cloudflare", "tencent"]);
		expect(result.routes).toEqual(expect.not.arrayContaining([expect.objectContaining({ routeType: "manual_unroutable" })]));
		expect(result.routes[0]).toMatchObject({
			routeType: "provider_submission",
			verifiedEmail: "abuse@cloudflare.com",
			resolverProvenance: {
				source: "domain_infrastructure_ip",
				originatingDomain: target,
				originatingIp: cloudflareIp,
			},
		});
		const snapshot = result.resolverSnapshot as Record<string, any>;
		expect(snapshot.infrastructure.dns.ignoredAddresses).toEqual(expect.arrayContaining([
			expect.objectContaining({ address: "10.0.0.1", reason: "not_public_ip" }),
			expect.objectContaining({ address: "2001:db8::1", reason: "not_public_ip" }),
			expect.objectContaining({ address: cloudflareIp, reason: "duplicate" }),
		]));
	});

	for (const { mailbox, provider } of [
		{ mailbox: "Abuse@Cloudflare.COM", provider: "cloudflare" },
		{ mailbox: "dnsabuse_complaint@tencent.com", provider: "tencent" },
		{ mailbox: "abuse@namesilo.com", provider: "namesilo" },
		{ mailbox: "support@namesilo.com", provider: "namesilo" },
	]) {
		test(`routes the exact ${mailbox} mailbox to the ${provider} direct provider`, async () => {
			const result = await resolveAbuseTarget(
				{ normalizedTarget: "example.com", targetType: "domain", observedUrls: [] },
				resolverWith({
					"https://rdap.test/domain/example.com": {
						entities: [{ roles: ["registrar"], entities: [abuseEntity(mailbox)] }],
					},
				}),
			);

			expect(result.routes).toEqual([
				expect.objectContaining({
					providerRegistryKey: provider,
					routeType: "provider_submission",
					status: "verified",
				}),
			]);
		});
	}

	test("keeps a lookalike provider mailbox on the generic email route", async () => {
		const result = await resolveAbuseTarget(
			{ normalizedTarget: "example.com", targetType: "domain", observedUrls: [] },
			resolverWith({
				"https://rdap.test/domain/example.com": {
					entities: [{ roles: ["registrar"], entities: [abuseEntity("abuse@sub.cloudflare.com")] }],
				},
			}),
		);

		expect(result.routes).toEqual([
			expect.objectContaining({
				providerRegistryKey: "email:sub.cloudflare.com",
				routeType: "email",
				verifiedEmail: "abuse@sub.cloudflare.com",
			}),
		]);
	});

	test("adds the Netcraft supplemental provider only when a domain has an observed URL", async () => {
		const dependencies = resolverWith({
			"https://rdap.test/domain/example.com": { entities: [] },
		});
		const withoutObservedUrl = await resolveAbuseTarget(
			{ normalizedTarget: "example.com", targetType: "domain", observedUrls: [] },
			dependencies,
		);
		const withObservedUrl = await resolveAbuseTarget(
			{ normalizedTarget: "example.com", targetType: "domain", observedUrls: ["https://example.com/phish"] },
			dependencies,
		);

		expect(withoutObservedUrl.routes).not.toEqual(expect.arrayContaining([
			expect.objectContaining({ providerRegistryKey: "netcraft" }),
		]));
		expect(withObservedUrl).toMatchObject({ status: "resolved" });
		expect(withObservedUrl.routes).toHaveLength(1);
		expect(withObservedUrl.routes).toEqual(expect.arrayContaining([
			expect.objectContaining({
				providerRegistryKey: "netcraft",
				routeType: "provider_submission",
				status: "verified",
			}),
		]));
	});

	test("keeps an actionable infrastructure route when domain RDAP fails", async () => {
		const target = "host.example.com";
		const infrastructureIp = "104.16.0.1";
		const result = await resolveAbuseTarget(
			{ normalizedTarget: target, targetType: "domain", observedUrls: [] },
			{
				assertPublicHost: async () => undefined,
				resolveDomainAddresses: async () => [infrastructureIp],
				rdapLocator: testRdapLocator,
				fetch: async (input) => {
					const url = String(input);
					if (url === "https://rdap.test/domain/example.com") throw new Error("domain RDAP unavailable");
					if (url === `https://rdap.test/ip/${infrastructureIp}`) return rdapResponse({ entities: [abuseEntity("abuse@cloudflare.com")] });
					return new Response(null, { status: 404 });
				},
			},
		);

		expect(result.status).toBe("resolved");
		expect(result.routes).toEqual([
			expect.objectContaining({ providerRegistryKey: "cloudflare", routeType: "provider_submission" }),
		]);
		expect((result.resolverSnapshot as Record<string, any>).domainRdap).toMatchObject({ error: "domain RDAP unavailable" });
		expect(result.lookupFailures).toEqual(["domain RDAP: domain RDAP unavailable"]);
	});

	test("a rate-limited hosting lookup is a lookup failure even when another route makes the target resolved", async () => {
		// policy-transparency-advisory.onrender.com: every RDAP lookup answered HTTP 429, so
		// Render's abuse mailbox was never found and only Netcraft received the report.
		const target = "policy-transparency-advisory.onrender.com";
		const result = await resolveAbuseTarget(
			{ normalizedTarget: target, targetType: "domain", observedUrls: [`https://${target}/help`] },
			{
				assertPublicHost: async () => undefined,
				resolveDomainAddresses: async () => ["216.24.57.16", "216.24.57.18"],
				rdapLocator: testRdapLocator,
				httpRetryAttempts: 1,
				fetch: async () => new Response(null, { status: 429 }),
			},
		);

		expect(result.status).toBe("resolved");
		expect(result.routes.map((route) => route.providerRegistryKey)).toEqual(["netcraft"]);
		// A tenant of Render's platform: only its hosting is asked, never onrender.com's registrar.
		expect(result.lookupFailures).toEqual([
			"IP RDAP for 216.24.57.16: Resolver request to rdap.test failed with HTTP 429.",
			"IP RDAP for 216.24.57.18: Resolver request to rdap.test failed with HTTP 429.",
		]);
	});

	test("a record that does not exist is not a lookup failure", async () => {
		const result = await resolveAbuseTarget(
			{ normalizedTarget: "203.0.113.9", targetType: "ip", observedUrls: [] },
			{ assertPublicHost: async () => undefined, rdapLocator: async () => undefined, fetch: async () => new Response(null, { status: 404 }) },
		);
		expect(result.status).toBe("no_route");
		expect(result.lookupFailures).toBeUndefined();
	});

	test("merges duplicate infrastructure routes without discarding either source", async () => {
		const target = "host.example.com";
		const firstIp = "104.16.0.1";
		const secondIp = "104.16.1.1";
		const result = await resolveAbuseTarget(
			{ normalizedTarget: target, targetType: "domain", observedUrls: [] },
			resolverWith(
				{
					[`https://rdap.test/domain/${target}`]: { entities: [] },
					[`https://rdap.test/ip/${firstIp}`]: { entities: [abuseEntity("abuse@cloudflare.com")] },
					[`https://rdap.test/ip/${secondIp}`]: { entities: [abuseEntity("abuse@cloudflare.com")] },
				},
				async () => "",
				async () => [firstIp, secondIp],
			),
		);

		expect(result.routes).toHaveLength(1);
		const route = result.routes[0]!;
		expect(route).toMatchObject({ providerRegistryKey: "cloudflare", routeType: "provider_submission" });
		expect((route.resolverProvenance as Record<string, any>).sourceProvenance).toEqual([
			expect.objectContaining({ originatingIp: firstIp }),
			expect.objectContaining({ originatingIp: secondIp }),
		]);
		expect((route.resolutionSnapshot as Record<string, any>).sourceSnapshots).toEqual([
			expect.objectContaining({ infrastructureIp: firstIp }),
			expect.objectContaining({ infrastructureIp: secondIp }),
		]);
	});

	test("does not route private or special-use DNS answers through the IP resolver", async () => {
		const target = "host.example.com";
		const requestedUrls: string[] = [];
		const result = await resolveAbuseTarget(
			{ normalizedTarget: target, targetType: "domain", observedUrls: [] },
			{
				assertPublicHost: async () => undefined,
				resolveDomainAddresses: async () => ["10.0.0.1", "127.0.0.1", "2001:db8::1"],
				rdapLocator: testRdapLocator,
				fetch: async (input) => {
					requestedUrls.push(String(input));
					return rdapResponse({ entities: [] });
				},
			},
		);

		expect(result).toMatchObject({ status: "no_route", disposition: "no_verified_abuse_contact" });
		expect(result.routes).toEqual([expect.objectContaining({ routeType: "manual_unroutable" })]);
		expect(requestedUrls).toEqual(["https://rdap.test/domain/example.com"]);
	});

});
