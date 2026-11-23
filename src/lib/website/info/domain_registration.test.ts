import { describe, expect, test } from "bun:test";

import type { ResolverDependencies } from "../../abuse/resolver/types";
import { testRdapLocator } from "../../network/rdap_test_helpers";
import { domainRegistration } from "./domain_registration";

const REGISTRAR_RDAP = "https://rdap.registrar.example/domain/";

function rdapFixtures(records: Record<string, unknown>, requested: string[] = []): ResolverDependencies {
	return {
		assertPublicHost: async () => undefined,
		rdapLocator: testRdapLocator,
		httpRetryAttempts: 1,
		fetch: async (input) => {
			const key = String(input);
			requested.push(key);
			const payload = records[key];
			return payload ? new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/rdap+json" } }) : new Response(null, { status: 404 });
		},
	};
}

function vcard(entries: Array<[string, string]>) {
	return ["vcard", entries.map(([key, value]) => [key, {}, "text", value])];
}

/** A thin .com registry record, as Verisign serves it: registrar, dates, nameservers, and a link to the registrar's record. */
function registry(domain: string, params: { registrarId: number; registrar: string; registered: string; nameservers: string[]; related?: boolean }) {
	return {
		ldhName: domain.toUpperCase(),
		links: [
			{ rel: "self", href: `https://rdap.test/domain/${domain}`, type: "application/rdap+json" },
			...(params.related === false ? [] : [{ rel: "related", href: `${REGISTRAR_RDAP}${domain}`, type: "application/rdap+json" }]),
		],
		events: [
			{ eventAction: "registration", eventDate: params.registered },
			{ eventAction: "expiration", eventDate: "2027-08-13T18:35:06Z" },
		],
		nameservers: params.nameservers.map((name) => ({ objectClassName: "nameserver", ldhName: name.toUpperCase() })),
		entities: [{ roles: ["registrar"], publicIds: [{ type: "IANA Registrar ID", identifier: String(params.registrarId) }], vcardArray: vcard([["fn", params.registrar]]) }],
	};
}

/** The registrar's own record, which names the registrant. */
function registrarRecord(registrant: Array<[string, string]>) {
	return {
		entities: [
			{ roles: ["registrant"], vcardArray: vcard(registrant) },
			{ roles: ["technical"], vcardArray: vcard([["fn", ""]]) },
			{ roles: ["registrar"], vcardArray: vcard([["org", "Markmonitor Inc."], ["fn", "Markmonitor Inc."]]) },
		],
	};
}

describe("domain registration evidence for the website classifier", () => {
	test("AWS GovCloud's sign-in domain shows Amazon at a brand-protection registrar", async () => {
		// signin.amazonaws-us-gov.com, 2026-11-19: reported as an AWS lookalike; its records name Amazon.
		const requested: string[] = [];
		const registration = await domainRegistration("signin.amazonaws-us-gov.com", rdapFixtures({
			"https://rdap.test/domain/amazonaws-us-gov.com": registry("amazonaws-us-gov.com", {
				registrarId: 292,
				registrar: "MarkMonitor Inc.",
				registered: "2012-08-13T18:35:06Z",
				nameservers: ["ns-1063.awsdns-04.org", "ns-524.awsdns-01.net"],
			}),
			[`${REGISTRAR_RDAP}amazonaws-us-gov.com`]: registrarRecord([["fn", "Hostmaster, Amazon Legal Dept."], ["org", "Amazon Technologies, Inc."]]),
		}, requested));
		expect(registration).toEqual({
			domain: "amazonaws-us-gov.com",
			registrar: "MarkMonitor",
			brandProtectionRegistrar: true,
			registrant: "Amazon Technologies, Inc.",
			registered: "2012-08-13",
			nameservers: ["ns-1063.awsdns-04.org", "ns-524.awsdns-01.net"],
		});
		// The registrable domain is looked up, never the host.
		expect(requested).toEqual(["https://rdap.test/domain/amazonaws-us-gov.com", `${REGISTRAR_RDAP}amazonaws-us-gov.com`]);
	});

	test("a redacted registrant is left out, and the brand's own nameservers remain", async () => {
		// google.com and youtube.com: MarkMonitor's record has an empty registrant; ns1.google.com serves both.
		const registration = await domainRegistration("www.youtube.com", rdapFixtures({
			"https://rdap.test/domain/youtube.com": registry("youtube.com", { registrarId: 292, registrar: "MarkMonitor Inc.", registered: "2005-02-15T05:13:12Z", nameservers: ["ns1.google.com", "ns2.google.com"] }),
			[`${REGISTRAR_RDAP}youtube.com`]: registrarRecord([["fn", ""]]),
		}));
		expect(registration).toEqual({ domain: "youtube.com", registrar: "MarkMonitor", brandProtectionRegistrar: true, registered: "2005-02-15", nameservers: ["ns1.google.com", "ns2.google.com"] });
	});

	test("privacy placeholders never pass for a registrant", async () => {
		for (const placeholder of ["REDACTED FOR PRIVACY", "Privacy service provided by Withheld for Privacy ehf", "Domains By Proxy, LLC", "Data Protected", "GDPR Masked", "Registrant of kit.example", "Not Disclosed"]) {
			const registration = await domainRegistration("kit.example", rdapFixtures({
				"https://rdap.test/domain/kit.example": registry("kit.example", { registrarId: 1068, registrar: "NameCheap, Inc.", registered: "2026-11-01T00:00:00Z", nameservers: ["dns1.registrar-servers.com"] }),
				[`${REGISTRAR_RDAP}kit.example`]: registrarRecord([["org", placeholder]]),
			}));
			expect(registration).not.toHaveProperty("registrant");
		}
	});

	test("a kit domain at a retail registrar reads as one", async () => {
		// eu-north-1.signin.aws.kippertranslation.com, 2026-11-20: a pixel copy of the AWS sign-in.
		const registration = await domainRegistration("eu-north-1.signin.aws.kippertranslation.com", rdapFixtures({
			"https://rdap.test/domain/kippertranslation.com": registry("kippertranslation.com", { registrarId: 303, registrar: "PDR Ltd. d/b/a PublicDomainRegistry.com", registered: "2023-07-11T13:26:19Z", nameservers: ["ns464.hostgator.com.br"], related: false }),
		}));
		expect(registration).toEqual({
			domain: "kippertranslation.com",
			registrar: "PDR Ltd. d/b/a PublicDomainRegistry.com",
			brandProtectionRegistrar: false,
			registered: "2023-07-11",
			nameservers: ["ns464.hostgator.com.br"],
		});
	});

	test("a registrar record that fails still leaves the registry's facts", async () => {
		const registration = await domainRegistration("amazonaws-us-gov.com", rdapFixtures({
			"https://rdap.test/domain/amazonaws-us-gov.com": registry("amazonaws-us-gov.com", { registrarId: 292, registrar: "MarkMonitor Inc.", registered: "2012-08-13T18:35:06Z", nameservers: [] }),
		}));
		expect(registration).toEqual({ domain: "amazonaws-us-gov.com", registrar: "MarkMonitor", brandProtectionRegistrar: true, registered: "2012-08-13" });
	});

	test("a platform tenant is named as one and its platform is never looked up", async () => {
		const requested: string[] = [];
		const dependencies = rdapFixtures({}, requested);
		// A kit on a Google or AWS platform imitating Google or AWS is that kit's site, whoever holds the platform's domain.
		expect(await domainRegistration("kit.firebaseapp.com", dependencies)).toEqual({ platformTenant: "kit.firebaseapp.com" });
		expect(await domainRegistration("bucket.s3.amazonaws.com", dependencies)).toEqual({ platformTenant: "bucket.s3.amazonaws.com" });
		expect(await domainRegistration("d3ixcffzcz1zze.cloudfront.net", dependencies)).toEqual({ platformTenant: "d3ixcffzcz1zze.cloudfront.net" });
		expect(await domainRegistration("sites.google.com", dependencies)).toEqual({ platformTenant: "sites.google.com" });
		expect(requested).toEqual([]);
	});

	test("an IP or an unregistered name has no registration", async () => {
		expect(await domainRegistration("203.0.113.7", rdapFixtures({}))).toBeUndefined();
		expect(await domainRegistration("missing.example", rdapFixtures({}))).toBeUndefined();
	});
});
