import { describe, expect, test } from "bun:test";

import { attributeHosting, hostingChange, hostingKey, networkIdentities, routedHosting, type SiteHosting } from "./hosting";
import { networkLookup, TRYLEVO_ROUTED_SNAPSHOT } from "./host_move.fixtures";

const attributed = async (...ips: string[]): Promise<SiteHosting> => attributeHosting({ addresses: ips.map((ip) => ({ ip })) }, undefined, networkLookup());

describe("attributing a check's addresses", () => {
	test("each public address gets its network, and a CDN's network names the CDN", async () => {
		expect((await attributed("85.137.52.128", "188.114.96.3")).addresses).toEqual([
			{ ip: "85.137.52.128", asn: 43641, holder: "Sollutium-NL SOLLUTIUM EU Sp z.o.o.", prefix: "85.137.52.0/24" },
			{ ip: "188.114.96.3", asn: 13335, holder: "CLOUDFLARENET - Cloudflare, Inc., US", prefix: "188.114.96.0/24", cdn: "Cloudflare" },
		]);
	});

	test("addresses the previous check attributed are not looked up again; private ones and failed lookups stay unattributed", async () => {
		const asked: string[] = [];
		const previous = { addresses: [{ ip: "85.137.52.128", asn: 43641, holder: "Sollutium-NL SOLLUTIUM EU Sp z.o.o." }] };
		expect((await attributeHosting({ addresses: ["85.137.52.128", "10.0.0.5", "203.0.113.10", "198.51.100.77", "5.161.1.1"].map((ip) => ({ ip })) }, previous, async (ip) => {
			asked.push(ip);
			if (ip === "5.161.1.1") throw new Error("RIPEstat timed out");
			return {};
		})).addresses).toEqual([
			{ ip: "85.137.52.128", asn: 43641, holder: "Sollutium-NL SOLLUTIUM EU Sp z.o.o." },
			{ ip: "10.0.0.5" },
			{ ip: "203.0.113.10" },
			{ ip: "198.51.100.77" },
			{ ip: "5.161.1.1" },
		]);
		expect(asked).toEqual(["5.161.1.1"]);
	});
});

describe("the hosting a target was reported on", () => {
	test("is read from the addresses its resolution routed it through", () => {
		expect(routedHosting(TRYLEVO_ROUTED_SNAPSHOT)).toEqual({
			addresses: [
				{ ip: "188.114.96.2", asn: 13335, holder: "Cloudflare, Inc.", prefix: "188.114.96.0/24", cdn: "Cloudflare" },
				{ ip: "188.114.97.2", asn: 13335, holder: "Cloudflare, Inc.", prefix: "188.114.97.0/24", cdn: "Cloudflare" },
			],
		});
	});

	test("a snapshot without infrastructure (an IP target, an older resolution) has none", () => {
		expect(routedHosting({ target: "45.33.32.156", ipRdap: {} })).toBeUndefined();
		expect(routedHosting({ infrastructure: { ipResolutions: [] } })).toBeUndefined();
		expect(routedHosting(null)).toBeUndefined();
	});
});

describe("whether a site moved", () => {
	test("Cloudflare to its own server: it left the CDN (trylevo.app)", async () => {
		expect(hostingChange(routedHosting(TRYLEVO_ROUTED_SNAPSHOT)!, await attributed("85.137.52.128"))).toEqual({
			kind: "left_cdn",
			from: { name: "Cloudflare", cdn: "Cloudflare", asn: 13335, holder: "Cloudflare, Inc.", addresses: ["188.114.96.2", "188.114.97.2"] },
			to: { name: "Sollutium-NL", asn: 43641, holder: "Sollutium-NL SOLLUTIUM EU Sp z.o.o.", addresses: ["85.137.52.128"] },
		});
	});

	test("one host to another: a new network", async () => {
		expect(hostingChange(await attributed("85.137.52.128"), await attributed("5.161.1.1"))).toMatchObject({ kind: "new_network", from: { name: "Sollutium-NL", asn: 43641 }, to: { name: "HETZNER-CLOUD2-AS", asn: 213230 } });
	});

	test("behind another CDN, from a host or from another CDN", async () => {
		expect(hostingChange(await attributed("85.137.52.128"), await attributed("151.101.1.195"))).toMatchObject({ kind: "new_cdn", to: { name: "Fastly", cdn: "Fastly" } });
		expect(hostingChange(await attributed("188.114.96.3"), await attributed("151.101.1.195"))).toMatchObject({ kind: "new_cdn", from: { cdn: "Cloudflare" }, to: { cdn: "Fastly" } });
		expect(hostingChange(await attributed("85.137.52.128"), await attributed("188.114.96.3"))).toMatchObject({ kind: "new_cdn", to: { cdn: "Cloudflare" } });
	});

	test("new addresses in the same network are no move: another CDN edge, a renumbered server", async () => {
		expect(hostingChange(routedHosting(TRYLEVO_ROUTED_SNAPSHOT)!, await attributed("188.114.96.3", "104.21.32.1"))).toBeUndefined();
		expect(hostingChange(await attributed("85.137.52.128"), await attributed("85.137.52.130"))).toBeUndefined();
	});

	test("a hosting that still includes a network of the old one is no move", async () => {
		expect(hostingChange(await attributed("85.137.52.128"), await attributed("85.137.52.130", "5.161.1.1"))).toBeUndefined();
	});

	test("an address whose network is unknown decides nothing", async () => {
		const unknown = { addresses: [{ ip: "198.51.100.77" }] };
		expect(hostingChange(routedHosting(TRYLEVO_ROUTED_SNAPSHOT)!, unknown)).toBeUndefined();
		expect(hostingChange(unknown, await attributed("85.137.52.128"))).toBeUndefined();
		expect(hostingChange({ addresses: [] }, await attributed("85.137.52.128"))).toBeUndefined();
	});
});
