import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import { browserUserAgent } from "../network/service_identity";
import { extractFavicon, iconIndexUrl, revalidateFavicon } from "./extract";
import { normalizeIcon } from "./image";
import { html, raster, scriptedWeb } from "./test_helpers";

const png = (colour = "#f38020", edge = 64) => raster("png", edge, edge, colour);
const image = async (colour?: string) => ({ body: await png(colour), headers: { "content-type": "image/png" } });

async function colourOf(icon: Buffer): Promise<number[]> {
	const { data } = await sharp(icon).raw().toBuffer({ resolveWithObject: true });
	return [...data.subarray(32 * 64 * 4 + 32 * 4, 32 * 64 * 4 + 32 * 4 + 3)];
}

describe("extractFavicon", () => {
	test("takes the best icon the home page declares, after its redirects, with a browser's headers", async () => {
		const web = scriptedWeb({
			"https://example.com/": { redirect: "https://www.example.com/en/" },
			"https://www.example.com/en/": html(`<link rel="icon" href="/fav-16.png" sizes="16x16"><link rel="icon" href="icons/fav-64.png" sizes="64x64">`),
			"https://www.example.com/en/icons/fav-64.png": await image("#00ff00"),
		});
		const result = await extractFavicon("example.com", web.dependencies);
		expect(result).toMatchObject({ found: true, source: { url: "https://www.example.com/en/icons/fav-64.png", kind: "file" } });
		expect(await colourOf(result.found ? result.png : Buffer.alloc(0))).toEqual([0, 255, 0]);
		expect(web.urls()).toEqual(["https://example.com/", "https://www.example.com/en/", "https://www.example.com/en/icons/fav-64.png"]);
		expect(web.requests.every(({ headers }) => headers["user-agent"] === browserUserAgent)).toBe(true);
	});

	test("moves on from an icon that is missing, an HTML page or too big, to /favicon.ico", async () => {
		const web = scriptedWeb({
			"https://example.com/": html(`
				<link rel="icon" href="/gone.png" sizes="64x64">
				<link rel="icon" href="/soft-404.png" sizes="48x48">
				<link rel="icon" href="/huge.png" sizes="32x32">`),
			"https://example.com/soft-404.png": html(""),
			"https://example.com/huge.png": { body: Buffer.alloc(300 * 1024), headers: { "content-type": "image/png", "content-length": String(300 * 1024) } },
			"https://example.com/favicon.ico": await image(),
		});
		expect(await extractFavicon("example.com", web.dependencies)).toMatchObject({ found: true, source: { url: "https://example.com/favicon.ico" } });
	});

	test("an inline data: icon is taken without a request, and remembered by the page that declared it", async () => {
		const inline = `data:image/png;base64,${(await png("#0000ff")).toString("base64")}`;
		const web = scriptedWeb({ "https://example.com/": html(`<link rel="icon" href="${inline}" sizes="64x64">`) });
		const result = await extractFavicon("example.com", web.dependencies);
		expect(result).toMatchObject({ found: true, source: { url: "https://example.com/", kind: "inline" } });
		expect(web.urls()).toEqual(["https://example.com/"]);
	});

	test("a home page that answers with an HTTP error still has its /favicon.ico asked", async () => {
		const web = scriptedWeb({ "https://example.com/": { status: 403, body: "Attention Required! | Cloudflare" }, "https://example.com/favicon.ico": await image() });
		expect(await extractFavicon("example.com", web.dependencies)).toMatchObject({ found: true, source: { url: "https://example.com/favicon.ico" } });
	});

	test("a site whose own server refuses us gets the icon index's icon (NameSilo's bot wall)", async () => {
		const web = scriptedWeb({
			"https://namesilo.com/": { status: 403, body: "Attention Required! | Cloudflare" },
			"https://namesilo.com/favicon.ico": { status: 403, body: "Attention Required! | Cloudflare" },
			[iconIndexUrl("namesilo.com")]: { redirect: "https://t0.gstatic.com/faviconV2?url=http://namesilo.com&size=64" },
			"https://t0.gstatic.com/faviconV2?url=http://namesilo.com&size=64": await image(),
		});
		expect(await extractFavicon("namesilo.com", web.dependencies)).toMatchObject({ found: true, source: { url: iconIndexUrl("namesilo.com"), kind: "file" } });
	});

	test("no icon anywhere: the site's own failure, with every reason", async () => {
		const declaredHtml = scriptedWeb({ "https://example.com/": html(`<link rel="icon" href="/page.png">`), "https://example.com/page.png": html("") });
		const invalid = await extractFavicon("example.com", declaredHtml.dependencies);
		expect(invalid).toMatchObject({ found: false, failure: "http" });
		expect(invalid.found ? "" : invalid.reason).toMatch(/page\.png: The file is not an image\..*favicon\.ico answered HTTP 404\..*icon index has none.*HTTP 404/);
		expect(declaredHtml.urls()).toContain(iconIndexUrl("example.com"));

		const garbage = scriptedWeb({ "https://example.com/": html(""), "https://example.com/favicon.ico": { body: "<html>soft 404</html>" } });
		expect(await extractFavicon("example.com", garbage.dependencies)).toMatchObject({ found: false, failure: "invalid" });

		const down = scriptedWeb({ "https://example.com/": { error: "getaddrinfo ENOTFOUND example.com" } });
		expect(await extractFavicon("example.com", down.dependencies)).toMatchObject({ found: false, failure: "network" });
		expect(down.urls()).toEqual(["https://example.com/", iconIndexUrl("example.com")]);
	});

	test("tries at most five declared icons", async () => {
		const links = Array.from({ length: 8 }, (_, index) => `<link rel="icon" href="/i${index}.png" sizes="64x64">`).join("");
		const web = scriptedWeb({ "https://example.com/": html(links) });
		await extractFavicon("example.com", web.dependencies);
		expect(web.urls().filter((url) => url.startsWith("https://example.com/i"))).toHaveLength(5);
	});

	test("never asks a host on a private address, nor the icon index about it", async () => {
		const web = scriptedWeb({}, ["intranet.example"]);
		expect(await extractFavicon("intranet.example", web.dependencies)).toMatchObject({ found: false, failure: "refused" });
		expect(web.urls()).toEqual([]);
	});

	test("never follows a redirect or an icon link to the private network", async () => {
		const toLocalhost = scriptedWeb({ "https://example.com/": { redirect: "http://127.0.0.1:3000/admin" } });
		expect(await extractFavicon("example.com", toLocalhost.dependencies)).toMatchObject({ found: false, failure: "refused" });
		expect(toLocalhost.urls()).toEqual(["https://example.com/"]);

		const metadata = scriptedWeb({
			"https://example.com/": html(`<link rel="icon" href="http://169.254.169.254/latest/meta-data/" sizes="64x64"><link rel="icon" href="https://internal.example.com/x.png" sizes="48x48">`),
			"https://example.com/favicon.ico": await image(),
		}, ["internal.example.com"]);
		expect(await extractFavicon("example.com", metadata.dependencies)).toMatchObject({ found: true, source: { url: "https://example.com/favicon.ico" } });
		expect(metadata.urls()).not.toContain("http://169.254.169.254/latest/meta-data/");
		expect(metadata.urls()).not.toContain("https://internal.example.com/x.png");
	});
});

describe("revalidateFavicon", () => {
	const source = { url: "https://example.com/favicon.png", kind: "file" as const };

	test("an icon file that still answers with the same image is unchanged; a new image replaces it", async () => {
		const stored = await normalizeIcon(await png());
		expect(await revalidateFavicon(source, stored, scriptedWeb({ [source.url]: await image() }).dependencies)).toEqual({ kind: "unchanged" });
		const updated = await revalidateFavicon(source, stored, scriptedWeb({ [source.url]: await image("#00ff00") }).dependencies);
		expect(updated.kind).toBe("updated");
		expect(await colourOf(updated.kind === "updated" ? updated.png : Buffer.alloc(0))).toEqual([0, 255, 0]);
	});

	test.each([404, 410, 403, 500])("an icon file that answers HTTP %i is gone", async (status) => {
		expect(await revalidateFavicon(source, Buffer.alloc(0), scriptedWeb({ [source.url]: { status } }).dependencies)).toMatchObject({ kind: "gone", reason: expect.stringContaining(`HTTP ${status}`) });
	});

	test("an icon file that serves an HTML page now is gone", async () => {
		expect(await revalidateFavicon(source, Buffer.alloc(0), scriptedWeb({ [source.url]: html("") }).dependencies)).toMatchObject({ kind: "gone" });
	});

	test("an icon file that cannot be reached is unreachable, not gone", async () => {
		expect(await revalidateFavicon(source, Buffer.alloc(0), scriptedWeb({ [source.url]: { error: "connect ETIMEDOUT" } }).dependencies)).toMatchObject({ kind: "unreachable", reason: expect.stringContaining("ETIMEDOUT") });
	});

	test("an icon file that now redirects to the private network is gone", async () => {
		expect(await revalidateFavicon(source, Buffer.alloc(0), scriptedWeb({ [source.url]: { redirect: "http://localhost/icon.png" } }).dependencies)).toMatchObject({ kind: "gone" });
	});

	test("an inline icon stays while the page that declared it answers", async () => {
		const inline = { url: "https://example.com/", kind: "inline" as const };
		expect(await revalidateFavicon(inline, Buffer.alloc(0), scriptedWeb({ [inline.url]: html("") }).dependencies)).toEqual({ kind: "unchanged" });
		expect(await revalidateFavicon(inline, Buffer.alloc(0), scriptedWeb({ [inline.url]: { status: 410 } }).dependencies)).toMatchObject({ kind: "gone" });
		expect(await revalidateFavicon(inline, Buffer.alloc(0), scriptedWeb({ [inline.url]: { error: "ECONNRESET" } }).dependencies)).toMatchObject({ kind: "unreachable" });
	});
});
