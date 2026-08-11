import { describe, expect, test } from "bun:test";

import type { WhoISInfo } from "../website_info";
import { collectInfrastructureAbuseContacts } from "./reportWebsitePhishing";

describe("collectInfrastructureAbuseContacts", () => {
	test("uses an explicit BGP-origin ASN RDAP abuse contact while excluding IP technical contacts", () => {
		const whois = {
			ip_rdaps: [
				{
					ip: "154.201.78.249",
					abuse: null,
					origin_asns: [
						{
							asn: 402506,
							prefix: "154.201.78.0/23",
							source: "ripe-stat",
							rdap: {
								abuse: {
									email: "abuse@tgtserver.com",
									remarks: "",
								},
							},
						},
					],
				},
			],
		} as WhoISInfo;

		expect(collectInfrastructureAbuseContacts(whois)).toEqual([
			{
				email: "abuse@tgtserver.com",
				ip: "154.201.78.249",
				contact: {
					email: "abuse@tgtserver.com",
					remarks: "",
				},
				source: "origin-asn-rdap",
				asn: 402506,
				prefix: "154.201.78.0/23",
			},
		]);
	});

	test("does not treat an ASN technical contact as a report target", () => {
		const whois = {
			ip_rdaps: [
				{
					ip: "154.201.78.249",
					abuse: null,
					origin_asns: [
						{
							asn: 402506,
							source: "ripe-stat",
							rdap: {
								abuse: null,
							},
						},
					],
				},
			],
		} as WhoISInfo;

		expect(collectInfrastructureAbuseContacts(whois)).toEqual([]);
	});
});
