import { describe, expect, test } from "bun:test";

import { asHolder, asHolderName, ipNetwork, locatedCountry, registeredCountry, ripeStatData } from "./ripestat";

const answering = (data: unknown, status = "ok") => {
	const urls: string[] = [];
	return { urls, fetch: async (url: string) => (urls.push(url), new Response(JSON.stringify({ status, data }), { headers: { "content-type": "application/json" } })) };
};

describe("RIPEstat", () => {
	test("asks the data call with the source app and returns its data", async () => {
		const ripe = answering({ asns: ["19318"] });
		expect(await ripeStatData("network-info", { resource: "192.0.2.1" }, ripe)).toEqual({ asns: ["19318"] });
		expect(ripe.urls).toEqual(["https://stat.ripe.net/data/network-info/data.json?resource=192.0.2.1&sourceapp=phishing-support"]);
	});

	test("refuses an answer that is not ok", async () => {
		await expect(ripeStatData("network-info", { resource: "x" }, answering({}, "error"))).rejects.toThrow("RIPEstat network-info returned an invalid response.");
	});

	test("the registered country of an IP or AS", async () => {
		expect(await registeredCountry("AS19318", answering({ located_resources: [{ resource: "19318", location: "US" }] }))).toBe("US");
		// Parts of a resource delegated to different countries name no single one.
		expect(await registeredCountry("192.0.2.0/23", answering({ located_resources: [{ location: "US" }, { location: "NL" }] }))).toBeUndefined();
		expect(await registeredCountry("AS0", answering({ located_resources: [] }))).toBeUndefined();
	});

	test("the network of an address: its announcing AS and prefix, and who holds the AS", async () => {
		expect(await ipNetwork("85.137.52.128", answering({ asns: ["43641"], prefix: "85.137.52.0/24" }))).toEqual({ asns: [43641], prefix: "85.137.52.0/24" });
		expect(await ipNetwork("192.0.2.1", answering({ asns: [], prefix: null }))).toEqual({ asns: [] });
		const overview = answering({ holder: "Sollutium-NL  SOLLUTIUM EU Sp z.o.o.", announced: true });
		expect(await asHolder(43641, overview)).toBe("Sollutium-NL SOLLUTIUM EU Sp z.o.o.");
		expect(overview.urls).toEqual(["https://stat.ripe.net/data/as-overview/data.json?resource=AS43641&sourceapp=phishing-support"]);
		expect(await asHolder(64496, answering({ holder: null }))).toBeUndefined();
	});

	test("the AS name a holder starts with", () => {
		expect(asHolderName("CLOUDFLARENET - Cloudflare, Inc., US")).toBe("CLOUDFLARENET");
		expect(asHolderName("Sollutium-NL SOLLUTIUM EU Sp z.o.o.")).toBe("Sollutium-NL");
		expect(asHolderName("HETZNER-CLOUD2-AS Hetzner Online GmbH")).toBe("HETZNER-CLOUD2-AS");
		expect(asHolderName("OVH SAS")).toBe("OVH");
		// A plain name is a name already.
		expect(asHolderName("Example Hosting GmbH")).toBe("Example Hosting GmbH");
		expect(asHolderName("Hetzner Online GmbH")).toBe("Hetzner Online GmbH");
	});

	test("the located country of an IP", async () => {
		expect(await locatedCountry("192.64.81.53", answering({ located_resources: [{ resource: "192.64.81.53/32", locations: [{ country: "us" }] }] }))).toBe("US");
		expect(await locatedCountry("192.0.2.1", answering({ located_resources: [{ locations: [{ country: "" }] }] }))).toBeUndefined();
	});
});
