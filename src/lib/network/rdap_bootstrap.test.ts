import { describe, expect, test } from "bun:test";

import { bootstrapServers, ianaRdapLocator, parseBootstrap } from "./rdap_bootstrap";

// Excerpts of IANA's registries, in their published shape.
const REGISTRIES: Record<string, unknown> = {
	"https://data.iana.org/rdap/ipv4.json": {
		version: "1.0",
		services: [
			[["216.0.0.0/8", "199.0.0.0/8"], ["https://rdap.arin.net/registry/", "http://rdap.arin.net/registry/"]],
			[["216.24.0.0/16"], ["https://rdap.more-specific.test/"]],
			[["41.0.0.0/8"], ["https://rdap.afrinic.net/rdap/", "http://rdap.afrinic.net/rdap/"]],
		],
	},
	"https://data.iana.org/rdap/ipv6.json": {
		services: [
			[["2600::/12"], ["https://rdap.arin.net/registry/"]],
			[["2a00::/12"], ["https://rdap.db.ripe.net/"]],
		],
	},
	"https://data.iana.org/rdap/dns.json": {
		services: [
			[["com", "net"], ["https://rdap.verisign.com/com/v1/"]],
			[["co.uk"], ["https://rdap.multi-label.test/"]],
			[["uk"], ["https://rdap.nominet.uk/uk/"]],
			[["plain"], ["http://rdap.insecure.test/"]],
		],
	},
	"https://data.iana.org/rdap/asn.json": {
		services: [
			[["1-1876", "36864"], ["https://rdap.arin.net/registry/"]],
			[["196608-210331"], ["https://rdap.db.ripe.net/"]],
		],
	},
};

function locatorWithRegistries(now = () => 0) {
	const loads: string[] = [];
	const locate = ianaRdapLocator(async (url) => {
		loads.push(url);
		if (!(url in REGISTRIES)) throw new Error(`HTTP 503 for ${url}`);
		return REGISTRIES[url];
	}, now);
	return { locate, loads };
}

describe("finding the authoritative RDAP server", () => {
	test("an IPv4 address goes to the most specific covering prefix", async () => {
		const { locate } = locatorWithRegistries();
		expect(await locate("ip", "216.24.57.16")).toBe("https://rdap.more-specific.test/ip/216.24.57.16");
		expect(await locate("ip", "216.25.0.1")).toBe("https://rdap.arin.net/registry/ip/216.25.0.1");
		expect(await locate("ip", "41.1.2.3")).toBe("https://rdap.afrinic.net/rdap/ip/41.1.2.3");
		expect(await locate("ip", "10.0.0.1")).toBeUndefined();
	});

	test("a CIDR goes to the server of its network address, with its length in the path", async () => {
		const { locate } = locatorWithRegistries();
		expect(await locate("ip", "216.24.0.0/17")).toBe("https://rdap.more-specific.test/ip/216.24.0.0/17");
		expect(await locate("ip", "2a01:4f8::/31")).toBe("https://rdap.db.ripe.net/ip/2a01:4f8::/31");
		expect(await locate("ip", "10.0.0.0/7")).toBeUndefined();
	});

	test("an IPv6 address, compressed or with an IPv4 tail, keeps its colons in the path", async () => {
		const { locate } = locatorWithRegistries();
		expect(await locate("ip", "2606:4700::1")).toBe("https://rdap.arin.net/registry/ip/2606:4700::1");
		expect(await locate("ip", "2a01:4f8:0:a0a1::2")).toBe("https://rdap.db.ripe.net/ip/2a01:4f8:0:a0a1::2");
		expect(await locate("ip", "2a00::ffff:192.0.2.1")).toBe("https://rdap.db.ripe.net/ip/2a00::ffff:192.0.2.1");
		expect(await locate("ip", "2001:db8::1")).toBeUndefined();
	});

	test("a domain goes to the server of its longest listed zone, never an HTTP-only one", async () => {
		const { locate } = locatorWithRegistries();
		expect(await locate("domain", "OnRender.com.")).toBe("https://rdap.verisign.com/com/v1/domain/onrender.com");
		expect(await locate("domain", "shop.example.co.uk")).toBe("https://rdap.multi-label.test/domain/shop.example.co.uk");
		expect(await locate("domain", "example.uk")).toBe("https://rdap.nominet.uk/uk/domain/example.uk");
		expect(await locate("domain", "site.plain")).toBeUndefined();
		expect(await locate("domain", "site.unlisted")).toBeUndefined();
	});

	test("an AS number goes to the server whose range holds it", async () => {
		const { locate } = locatorWithRegistries();
		expect(await locate("autnum", "1876")).toBe("https://rdap.arin.net/registry/autnum/1876");
		expect(await locate("autnum", "36864")).toBe("https://rdap.arin.net/registry/autnum/36864");
		expect(await locate("autnum", "209242")).toBe("https://rdap.db.ripe.net/autnum/209242");
		expect(await locate("autnum", "1877")).toBeUndefined();
	});

	test("each registry is loaded once a day; a failed load is tried again on the next lookup", async () => {
		let now = 0;
		const { locate, loads } = locatorWithRegistries(() => now);
		await locate("ip", "216.24.57.16");
		await locate("ip", "216.24.57.18");
		await locate("domain", "onrender.com");
		expect(loads).toEqual(["https://data.iana.org/rdap/ipv4.json", "https://data.iana.org/rdap/dns.json"]);
		now = 24 * 60 * 60_000;
		await locate("ip", "216.24.57.16");
		expect(loads.filter((url) => url.endsWith("ipv4.json"))).toHaveLength(2);

		let failing = true;
		const flaky = ianaRdapLocator(async (url) => {
			if (failing) throw new Error("HTTP 503");
			return REGISTRIES[url];
		});
		await expect(flaky("ip", "216.24.57.16")).rejects.toThrow("HTTP 503");
		failing = false;
		expect(await flaky("ip", "216.24.57.16")).toBe("https://rdap.more-specific.test/ip/216.24.57.16");
	});

	test("a registry without services is refused; malformed services are skipped", () => {
		expect(() => parseBootstrap({ version: "1.0" })).toThrow("no services");
		const services = parseBootstrap({ services: [["216.0.0.0/8"], [["COM"], ["https://rdap.verisign.com/com/v1/"]], [[42], "x"]] });
		expect(services).toEqual([{ entries: ["com"], servers: ["https://rdap.verisign.com/com/v1/"] }]);
		expect(bootstrapServers("ipv4", [{ entries: ["not-a-cidr", "216.0.0.0/99"], servers: ["https://x.test/"] }], "216.1.1.1")).toBeUndefined();
	});
});
