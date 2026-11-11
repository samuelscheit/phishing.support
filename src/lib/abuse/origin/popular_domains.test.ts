import { afterEach, describe, expect, test } from "bun:test";

import { isPopularSite, loadPopularDomains, POPULAR_DOMAIN_COUNT, resetPopularDomains } from "./popular_domains";

const LATEST = "https://tranco-list.eu/api/lists/date/latest";

/** Tranco's two endpoints: the latest list's id, then its top domains as `rank,domain` lines. */
function tranco(options: { listId?: string; available?: boolean; domains?: string[]; failLatest?: number } = {}) {
	const requests: string[] = [];
	let failures = options.failLatest ?? 0;
	const domains = options.domains ?? ["google.com", "x.com", ...Array.from({ length: POPULAR_DOMAIN_COUNT - 2 }, (_, index) => `site-${index}.com`)];
	const fetch = async (url: string) => {
		requests.push(url);
		if (url === LATEST) {
			if (failures-- > 0) return new Response("unavailable", { status: 503 });
			return Response.json({ list_id: options.listId ?? "Y895G", available: options.available ?? true, download: "ignored" });
		}
		return new Response(domains.map((domain, index) => `${index + 1},${domain}`).join("\r\n"), { headers: { "content-type": "text/csv" } });
	};
	return { fetch, requests };
}

afterEach(() => resetPopularDomains());

describe("popular sites from the Tranco list", () => {
	test("downloads the latest list's top domains once a day", async () => {
		const { fetch, requests } = tranco();
		let now = 1_000;
		const first = await loadPopularDomains({ fetch, now: () => now });
		expect(requests).toEqual([LATEST, `https://tranco-list.eu/download/Y895G/${POPULAR_DOMAIN_COUNT}`]);
		expect(first.size).toBe(POPULAR_DOMAIN_COUNT);
		expect(first.has("x.com")).toBe(true);

		now += 23 * 60 * 60_000;
		expect(await loadPopularDomains({ fetch, now: () => now })).toBe(first);
		expect(requests).toHaveLength(2);

		now += 2 * 60 * 60_000;
		await loadPopularDomains({ fetch, now: () => now });
		expect(requests).toHaveLength(4);
	});

	test("shares one download between concurrent callers", async () => {
		const { fetch, requests } = tranco();
		const [a, b] = await Promise.all([loadPopularDomains({ fetch }), loadPopularDomains({ fetch })]);
		expect(a).toBe(b);
		expect(requests).toHaveLength(2);
	});

	test("lets the next caller retry after a failed download", async () => {
		// Two attempts per request; both fail.
		const { fetch, requests } = tranco({ failLatest: 2 });
		await expect(loadPopularDomains({ fetch })).rejects.toThrow();
		expect((await loadPopularDomains({ fetch })).has("x.com")).toBe(true);
		expect(requests.filter((url) => url === LATEST)).toHaveLength(3);
	});

	test("refuses a truncated list instead of letting most brands through", async () => {
		const { fetch } = tranco({ domains: ["google.com", "x.com"] });
		await expect(loadPopularDomains({ fetch })).rejects.toThrow("held only 2 domains");
	});

	test("refuses a list that is not available or has a malformed id", async () => {
		await expect(loadPopularDomains({ fetch: tranco({ available: false }).fetch })).rejects.toThrow("did not name an available latest list");
		resetPopularDomains();
		const traversal = tranco({ listId: "../../admin" });
		await expect(loadPopularDomains({ fetch: traversal.fetch })).rejects.toThrow("did not name an available latest list");
		expect(traversal.requests).toEqual([LATEST]);
	});

	test("judges each host by its own site, platform tenants and path tenants included", () => {
		const popular = new Set(["x.com", "twimg.com", "workers.dev", "dpdns.org", "google.com", "co.uk"]);
		expect(isPopularSite("x.com", popular)).toBe(true);
		expect(isPopularSite("WWW.X.COM.", popular)).toBe(true);
		expect(isPopularSite("abs.twimg.com", popular)).toBe(true);
		expect(isPopularSite("accounts.google.com", popular)).toBe(true);
		// Tenants of a ranked platform are separate sites.
		expect(isPopularSite("x-clone.workers.dev", popular)).toBe(false);
		expect(isPopularSite("quiz.int.vidio.com.ntc.fzstore.dpdns.org", popular)).toBe(false);
		// Path tenants are sites of their own, whatever their host's rank.
		expect(isPopularSite("sites.google.com", popular)).toBe(false);
		// Lookalikes are not the brand.
		expect(isPopularSite("x-com.email", popular)).toBe(false);
		expect(isPopularSite("assistdeparments-x.com", popular)).toBe(false);
		expect(isPopularSite("x.com.evil.example", popular)).toBe(false);
		// A public suffix alone is never a site.
		expect(isPopularSite("co.uk", popular)).toBe(false);
		expect(isPopularSite("", popular)).toBe(false);
		expect(isPopularSite("8.8.8.8", popular)).toBe(false);
	});
});
