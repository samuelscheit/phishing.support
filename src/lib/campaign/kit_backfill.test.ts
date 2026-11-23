import { describe, expect, test } from "bun:test";

import { SubmissionsEntity } from "../db/entities/submissions";
import { useTemporaryDatabase } from "../db/test_helpers";
import { kitFingerprints } from "../abuse/origin/siblings";
import { backfillKitResources, textMatch } from "./kit_backfill";

useTemporaryDatabase();

const OUR_PAGE = "Exodus Wallet Restore your wallet Enter the 12 word secret recovery phrase of your Exodus wallet to restore access to your funds. Your phrase never leaves this device. Restore wallet Need help? Contact Exodus support any time of day.";
const KIT_HTML = `<html><head><title>Exodus Wallet</title></head><body><h1>Restore your wallet</h1><p>Enter the 12 word secret recovery phrase of your Exodus wallet to restore access to your funds. Your phrase never leaves this device.</p><button>Restore wallet</button><p>Need help? Contact Exodus support any time of day.</p></body></html>`;
const DOWN_HTML = "<html><head><title>503 - Service Unavailable</title></head><body><h1>503</h1><p>The service is unavailable.</p></body></html>";
const PARKED_HTML = "<html><head><title>exodus-test.com is for sale</title></head><body><p>This domain may be for sale. Buy this domain today and start your next project with a premium name.</p></body></html>";

const SCRIPT = "1".repeat(64);
const STYLE = "2".repeat(64);

/** urlscan as the backfill reads it: a search of the site's scans, each scan's DOM, and the kit scan's recorded responses. */
function urlscan(scans: Array<{ id: string; html: string }>) {
	const requested: string[] = [];
	const fetch = async (url: string) => {
		const { pathname, searchParams } = new URL(url);
		requested.push(pathname.startsWith("/api/v1/search") ? `search ${searchParams.get("q")}` : pathname);
		if (pathname.startsWith("/api/v1/search")) {
			return Response.json({ results: scans.map(({ id }) => ({ _id: id, page: { url: "https://exodus-test.com/restore" }, task: { url: "http://exodus-test.com/", time: "2026-10-29T07:04:21.138Z" } })) });
		}
		const dom = pathname.match(/^\/dom\/(.+)\/$/)?.[1];
		if (dom) return new Response(scans.find(({ id }) => id === dom)!.html);
		return Response.json({ data: { requests: [
			{ request: { type: "Document", request: { url: "https://exodus-test.com/restore" } }, response: { hash: "9".repeat(64), dataLength: 4_000, response: { status: 200, mimeType: "text/html" } } },
			{ request: { type: "Script", request: { url: "https://exodus-test.com/kit.js" } }, response: { hash: SCRIPT, dataLength: 48_000, response: { status: 200, mimeType: "application/javascript; charset=utf-8" } } },
			{ request: { type: "Stylesheet", request: { url: "https://exodus-test.com/kit.css" } }, response: { hash: STYLE, dataLength: 12_000, response: { status: 200, mimeType: "text/css" } } },
			{ request: { type: "Script", request: { url: "https://exodus-test.com/missing.js" } }, response: { hash: "3".repeat(64), dataLength: 900, response: { status: 404, mimeType: "text/html" } } },
			{ request: { type: "Image", request: { url: "https://exodus-test.com/logo.png" } }, response: { hash: "4".repeat(64), dataLength: 9_000, response: { status: 200, mimeType: "image/png" } } },
		] } });
	};
	return { fetch, requested };
}

async function oldSite(id: bigint, website: Record<string, unknown> = {}) {
	await SubmissionsEntity.create({ id, kind: "website", data: { kind: "website", website: { url: "https://exodus-test.com/restore", ...website } }, dedupeKey: `website-${id}`, status: "reported" });
}

const loadPageTexts = async () => [{ name: "website.mhtml", text: OUR_PAGE }];

describe("kit files from urlscan for a capture that recorded none", () => {
	test("take the scan whose page shows ours, not the down or parked site's later scans, and only its scripts and stylesheets", async () => {
		await oldSite(1n);
		const { fetch, requested } = urlscan([{ id: "down", html: DOWN_HTML }, { id: "parked", html: PARKED_HTML }, { id: "kit", html: KIT_HTML }]);
		const outcome = await backfillKitResources(1n, { fetch, apiKey: "test", loadPageTexts, now: () => new Date("2026-11-20T00:00:00Z") });
		expect(outcome).toEqual({ kind: "matched", scanId: "kit", resources: 2, textMatch: 1 });
		expect(requested).toEqual(['search page.domain:"exodus-test.com"', "/dom/down/", "/dom/parked/", "/dom/kit/", "/api/v1/result/kit/"]);
		const website = (await SubmissionsEntity.get(1n))!.data;
		if (website.kind !== "website") throw new Error("not a website");
		expect(website.website.urlscanKit).toEqual({
			checkedAt: "2026-11-20T00:00:00.000Z",
			scan: { id: "kit", url: "https://exodus-test.com/restore", scannedAt: "2026-10-29T07:04:21.138Z", textMatch: 1 },
			resources: [
				{ url: "https://exodus-test.com/kit.js", mimeType: "application/javascript", sha256: SCRIPT, size: 48_000 },
				{ url: "https://exodus-test.com/kit.css", mimeType: "text/css", sha256: STYLE, size: 12_000 },
			],
		});
		// The files identify the kit like a capture's own: its campaign links and searches by them.
		expect(kitFingerprints(website.website).map(({ sha256, kind }) => ({ sha256, kind }))).toEqual([{ sha256: SCRIPT, kind: "script" }, { sha256: STYLE, kind: "stylesheet" }]);
		// A matched site is never asked again.
		expect(await backfillKitResources(1n, { fetch, apiKey: "test", loadPageTexts })).toEqual({ kind: "not_needed" });
	});

	test("no scan showing our page leaves the site without files, and urlscan is asked again only a month later", async () => {
		await oldSite(2n);
		const { fetch, requested } = urlscan([{ id: "down", html: DOWN_HTML }]);
		const at = (iso: string) => ({ fetch, apiKey: "test", loadPageTexts, now: () => new Date(iso) });
		expect(await backfillKitResources(2n, at("2026-11-20T00:00:00Z"))).toEqual({ kind: "no_match", scans: 1, reason: "no scan showed our page" });
		expect(await backfillKitResources(2n, at("2026-12-10T00:00:00Z"))).toEqual({ kind: "recently_checked" });
		expect(requested).toHaveLength(2);
		expect((await backfillKitResources(2n, at("2026-12-21T00:00:00Z"))).kind).toBe("no_match");
		expect(requested).toHaveLength(4);
	});

	test("a capture that recorded its files, or has no readable page, is not matched against urlscan", async () => {
		await oldSite(3n, { kitResources: [{ url: "https://exodus-test.com/kit.js", mimeType: "application/javascript", sha256: SCRIPT, size: 48_000 }] });
		const { fetch, requested } = urlscan([{ id: "kit", html: KIT_HTML }]);
		expect(await backfillKitResources(3n, { fetch, apiKey: "test", loadPageTexts })).toEqual({ kind: "not_needed" });
		expect(requested).toEqual([]);

		await oldSite(4n);
		expect(await backfillKitResources(4n, { fetch, apiKey: "test", loadPageTexts: async () => [] })).toEqual({ kind: "no_match", scans: 0, reason: "our capture has no readable page" });
		expect(requested).toEqual([]);
	});

	test("urlscan busy while scans are read concludes nothing: it throws and records no check", async () => {
		await oldSite(5n);
		const { fetch: answering } = urlscan([{ id: "down", html: DOWN_HTML }, { id: "kit", html: KIT_HTML }]);
		const busyOnDom = async (url: string) => (new URL(url).pathname.startsWith("/dom/") ? new Response("quota", { status: 429 }) : answering(url));
		await expect(backfillKitResources(5n, { fetch: busyOnDom, apiKey: "test", loadPageTexts })).rejects.toThrow("HTTP 429");
		const data = (await SubmissionsEntity.get(5n))!.data;
		expect(data.kind === "website" && data.website.urlscanKit).toBeUndefined();
	});

	test("only the analyzed page is matched, and the backfill writes only its own field", async () => {
		// The visit moved on from a gate page; the analyzed page is its second step.
		await oldSite(6n, { analyzedHopIndex: 1, navigationHops: [{ index: 0, url: "https://exodus-test.com/", hostname: "exodus-test.com", status: 200, contentCaptured: false, visitorStep: { submitted: [] } }, { index: 1, url: "https://exodus-test.com/restore", hostname: "exodus-test.com", status: 200, contentCaptured: true }] });
		const { fetch } = urlscan([{ id: "kit", html: KIT_HTML }]);
		const pages = async () => [{ name: "website.mhtml", text: OUR_PAGE }, { name: "website-step2.mhtml", text: "Checking your browser before accessing the site. This process is automatic and you will be redirected shortly to the requested content." }];
		expect(await backfillKitResources(6n, { fetch, apiKey: "test", loadPageTexts: pages })).toMatchObject({ kind: "no_match", reason: "no scan showed our page" });

		// Something else changed the submission while the backfill read urlscan: it stays.
		await oldSite(7n);
		const { fetch: slow } = urlscan([{ id: "kit", html: KIT_HTML }]);
		const meanwhile = async (url: string) => {
			if (new URL(url).pathname.startsWith("/dom/")) {
				const current = (await SubmissionsEntity.get(7n))!.data;
				if (current.kind === "website") await SubmissionsEntity.update(7n, { data: { kind: "website", website: { ...current.website, investigation: { status: "running", updatedAt: "2026-11-20T00:00:00.000Z" } } } });
			}
			return slow(url);
		};
		expect((await backfillKitResources(7n, { fetch: meanwhile, apiKey: "test", loadPageTexts })).kind).toBe("matched");
		const data = (await SubmissionsEntity.get(7n))!.data;
		expect(data.kind === "website" && data.website.investigation?.status).toBe("running");
		expect(data.kind === "website" && data.website.urlscanKit?.resources).toHaveLength(2);
	});

	test("text match is the share of our page's word triples the other page shows; a page too short to tell matches nothing", () => {
		expect(textMatch(OUR_PAGE, OUR_PAGE.toUpperCase())).toBe(1);
		expect(textMatch(OUR_PAGE, PARKED_HTML)).toBe(0);
		expect(textMatch("Sign in", "Sign in")).toBe(0);
	});
});
