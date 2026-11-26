import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import { useTemporaryDatabase } from "@/lib/db/test_helpers";
import { FaviconStore } from "@/lib/favicon/store";
import { raster } from "@/lib/favicon/test_helpers";
import { GET } from "./route";

useTemporaryDatabase();

const NOW = new Date("2026-11-27T10:00:00Z");
const get = (domain: string, query = "") => GET(new Request(`http://localhost/api/favicons/${domain}${query}`), { params: Promise.resolve({ domain }) });

async function found(domain: string): Promise<string> {
	await FaviconStore.iconsFor([domain], NOW);
	await FaviconStore.recordFound(domain, await raster("png", 64), { url: `https://${domain}/favicon.ico`, kind: "file" }, NOW, NOW);
	return (await FaviconStore.get(domain))!.version!;
}

function expectHardened(response: Response) {
	expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	expect(response.headers.get("content-security-policy")).toBe("default-src 'none'");
	expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
}

describe("GET /api/favicons/[domain]", () => {
	test("serves the stored PNG under its version for a year, immutable", async () => {
		const version = await found("cloudflare.com");
		const response = await get("cloudflare.com", `?v=${version}`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(response.headers.get("etag")).toBe(`"${version}"`);
		expectHardened(response);
		const body = Buffer.from(await response.arrayBuffer());
		expect(response.headers.get("content-length")).toBe(String(body.length));
		expect((await sharp(body).metadata()).format).toBe("png");
	});

	test("an outdated or missing version gets the current icon, cached only briefly", async () => {
		await found("cloudflare.com");
		for (const query of ["?v=0000000000000000", ""]) {
			const response = await get("cloudflare.com", query);
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
		}
	});

	test("a domain without a stored icon is 404, never cached, and never fetched", async () => {
		await FaviconStore.iconsFor(["pending.com"], NOW);
		await FaviconStore.iconsFor(["missing.com"], NOW);
		await FaviconStore.recordMissing("missing.com", "http", "HTTP 404", NOW, NOW);
		for (const domain of ["pending.com", "missing.com", "never-seen.com"]) {
			const response = await get(domain);
			expect(response.status).toBe(404);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expectHardened(response);
		}
		expect(await FaviconStore.get("never-seen.com")).toBeUndefined();
	});

	test.each(["localhost", "127.0.0.1", "dash.cloudflare.com", "CLOUDFLARE.COM", "..%2F..%2Fetc", "cloudflare.com%2Fx", "%E0%A4%A"])("refuses %s, which is no registrable domain", async (domain) => {
		await found("cloudflare.com");
		const response = await get(domain);
		expect(response.status).toBe(404);
		expectHardened(response);
	});
});
