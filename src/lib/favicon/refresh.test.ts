import { describe, expect, test } from "bun:test";

import { useTemporaryDatabase } from "../db/test_helpers";
import { iconIndexUrl } from "./extract";
import { MISSING_RETRY_MS, REVALIDATE_AFTER_MS, refreshDueFavicons, UNREACHABLE_RETRY_MS } from "./refresh";
import { FaviconStore, faviconPath, onNewFaviconDomains } from "./store";
import { html, raster, scriptedWeb, type Answer } from "./test_helpers";

useTemporaryDatabase();

const T0 = new Date("2026-11-27T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const DAY = 24 * 60 * 60_000;
const image = async (colour = "#f38020") => ({ body: await raster("png", 64, 64, colour), headers: { "content-type": "image/png" } });

/** One background pass at `now` over the scripted web; returns the domains it fetched. */
async function pass(now: Date, site: Record<string, Answer>) {
	const web = scriptedWeb(site);
	await refreshDueFavicons({ now: () => now, dependencies: web.dependencies });
	return web.urls();
}

describe("FaviconStore.iconsFor", () => {
	test("a domain never asked for is recorded as pending, due at once, and shows no icon yet: the page never waits", async () => {
		let woken = 0;
		const stop = onNewFaviconDomains(() => { woken += 1; });
		try {
			expect(await FaviconStore.iconsFor(["cloudflare.com", "v-sys.org", "cloudflare.com"], T0)).toEqual(new Map());
			expect(await FaviconStore.get("cloudflare.com")).toMatchObject({ status: "pending", checkAt: T0, png: null });
			expect(woken).toBe(1);
			await FaviconStore.iconsFor(["cloudflare.com"], T0);
			expect(woken).toBe(1);
		} finally {
			stop();
		}
	});

	test("only registrable domains are kept: no host, IP address, upper case, public suffix or tenant of a shared host", async () => {
		const refused = ["dash.cloudflare.com", "127.0.0.1", "[::1]", "localhost", "Cloudflare.com", "co.uk", "evil.github.io", "example.com/path", ""];
		await FaviconStore.iconsFor(refused, T0);
		for (const domain of refused) expect(await FaviconStore.get(domain)).toBeUndefined();
	});

	test("a found icon is served under its version; a missing one keeps the initials", async () => {
		await FaviconStore.iconsFor(["cloudflare.com", "nowhere.example"], T0);
		await pass(T0, { "https://cloudflare.com/": html(`<link rel="icon" href="/favicon.png" sizes="64x64">`), "https://cloudflare.com/favicon.png": await image() });
		const { version } = (await FaviconStore.get("cloudflare.com"))!;
		expect(version).toMatch(/^[0-9a-f]{16}$/);
		expect(await FaviconStore.iconsFor(["cloudflare.com", "nowhere.example"], T0)).toEqual(new Map([["cloudflare.com", faviconPath("cloudflare.com", version!)]]));
	});
});

describe("refreshDueFavicons", () => {
	test("extracts a pending domain once, and leaves it alone until its revalidation a month later", async () => {
		await FaviconStore.iconsFor(["example.com"], T0);
		const site = { "https://example.com/": html(`<link rel="icon" href="/i.png" sizes="64x64">`), "https://example.com/i.png": await image() };
		expect(await pass(T0, site)).toEqual(["https://example.com/", "https://example.com/i.png"]);
		expect(await FaviconStore.get("example.com")).toMatchObject({ status: "found", fetchedAt: T0, checkAt: at(REVALIDATE_AFTER_MS), source: { url: "https://example.com/i.png", kind: "file" } });
		expect(await pass(at(REVALIDATE_AFTER_MS - 1), site)).toEqual([]);
		// The revalidation asks the icon file only, not the page again.
		expect(await pass(at(REVALIDATE_AFTER_MS), site)).toEqual(["https://example.com/i.png"]);
		expect(await FaviconStore.get("example.com")).toMatchObject({ status: "found", checkAt: at(2 * REVALIDATE_AFTER_MS) });
	});

	test("a domain without an icon is a negative entry, asked again only after a week", async () => {
		await FaviconStore.iconsFor(["example.com"], T0);
		const nothing = { "https://example.com/": html("") };
		await pass(T0, nothing);
		expect(await FaviconStore.get("example.com")).toMatchObject({ status: "missing", failure: "http", checkAt: at(MISSING_RETRY_MS) });
		expect(await pass(at(MISSING_RETRY_MS - 1), nothing)).toEqual([]);
		expect(await pass(at(MISSING_RETRY_MS), { ...nothing, "https://example.com/favicon.ico": await image() })).toContain("https://example.com/favicon.ico");
		expect(await FaviconStore.get("example.com")).toMatchObject({ status: "found", failure: null, reason: null });
	});

	test("a site that cannot be reached is asked again after a day", async () => {
		await FaviconStore.iconsFor(["example.com"], T0);
		await pass(T0, { "https://example.com/": { error: "connect ECONNREFUSED" } });
		expect(await FaviconStore.get("example.com")).toMatchObject({ status: "missing", failure: "network", checkAt: at(UNREACHABLE_RETRY_MS) });
	});

	test.each([404, 410])("drops an icon whose source now answers HTTP %i, and extracts it again", async (status) => {
		await FaviconStore.iconsFor(["example.com"], T0);
		await pass(T0, { "https://example.com/": html(`<link rel="icon" href="/old.png" sizes="64x64">`), "https://example.com/old.png": await image() });
		const old = (await FaviconStore.get("example.com"))!.version;

		const later = at(REVALIDATE_AFTER_MS);
		expect(await pass(later, {
			"https://example.com/old.png": { status },
			"https://example.com/": html(`<link rel="icon" href="/new.png" sizes="64x64">`),
			"https://example.com/new.png": await image("#00ff00"),
		})).toEqual(["https://example.com/old.png", "https://example.com/", "https://example.com/new.png"]);
		const entry = (await FaviconStore.get("example.com"))!;
		expect(entry).toMatchObject({ status: "found", source: { url: "https://example.com/new.png" }, fetchedAt: later });
		expect(entry.version).not.toBe(old);
	});

	test("drops an icon whose source is gone and that the site no longer has: initials until the retry", async () => {
		await FaviconStore.iconsFor(["example.com"], T0);
		await pass(T0, { "https://example.com/": html(""), "https://example.com/favicon.ico": await image() });
		await pass(at(REVALIDATE_AFTER_MS), { "https://example.com/favicon.ico": { status: 410 }, [iconIndexUrl("example.com")]: { status: 404 } });
		expect(await FaviconStore.get("example.com")).toMatchObject({ status: "missing", png: null, version: null, checkAt: at(REVALIDATE_AFTER_MS + MISSING_RETRY_MS) });
		expect(await FaviconStore.iconsFor(["example.com"], T0)).toEqual(new Map());
		expect(await FaviconStore.served("example.com")).toBeUndefined();
	});

	test("keeps the icon through a network failure of its source, and asks again a day later", async () => {
		await FaviconStore.iconsFor(["example.com"], T0);
		await pass(T0, { "https://example.com/": html(""), "https://example.com/favicon.ico": await image() });
		const before = (await FaviconStore.get("example.com"))!;
		const later = at(REVALIDATE_AFTER_MS);
		expect(await pass(later, { "https://example.com/favicon.ico": { error: "connect ETIMEDOUT" } })).toEqual(["https://example.com/favicon.ico"]);
		const after = (await FaviconStore.get("example.com"))!;
		expect(after).toMatchObject({ status: "found", version: before.version, fetchedAt: T0, checkAt: at(REVALIDATE_AFTER_MS + UNREACHABLE_RETRY_MS), reason: expect.stringContaining("ETIMEDOUT") });
		expect(after.png).toEqual(before.png);
	});

	test("a claimed domain is not taken by another refresher until its lease lapses", async () => {
		await FaviconStore.iconsFor(["example.com"], T0);
		expect((await FaviconStore.claimDue(T0, 120_000))?.domain).toBe("example.com");
		expect(await FaviconStore.claimDue(at(60_000), 120_000)).toBeUndefined();
		expect((await FaviconStore.claimDue(at(120_000), 120_000))?.domain).toBe("example.com");
	});

	test("refreshes every due domain in one pass, soonest due first, and none that is not due", async () => {
		await FaviconStore.iconsFor(["beta.com"], at(1_000));
		await FaviconStore.iconsFor(["alpha.com"], T0);
		await FaviconStore.iconsFor(["later.com"], at(DAY));
		const fetched = await pass(at(2_000), {});
		expect(fetched.filter((url) => url.endsWith(".com/"))).toEqual(["https://alpha.com/", "https://beta.com/"]);
		expect(await FaviconStore.get("later.com")).toMatchObject({ status: "pending" });
	});
});
