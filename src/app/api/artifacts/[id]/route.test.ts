import { describe, expect, test } from "bun:test";

import { ArtifactsEntity } from "@/lib/db/entities/artifacts";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import { useTemporaryDatabase } from "@/lib/db/test_helpers";
import { GET } from "./route";

useTemporaryDatabase();

const get = (id: string) => GET(new Request(`http://localhost/api/artifacts/${id}`), { params: Promise.resolve({ id }) });

async function stored(name: string | undefined, mimeType: string | undefined, bytes = Buffer.from("<script>alert(document.cookie)</script>")) {
	// Every test has a fresh database.
	await SubmissionsEntity.create({ id: 1n, kind: "website", data: { kind: "website", website: { url: "https://kit.example.com/" } }, dedupeKey: "artifact-route-test", status: "reported" });
	const id = await ArtifactsEntity.saveBuffer({ submissionId: 1n, name, kind: "website_evidence", mimeType, buffer: bytes });
	return { id: id.toString(), bytes };
}

/** What every response must carry, whatever it serves. */
function expectHardened(response: Response) {
	expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	expect(response.headers.get("content-security-policy")).toBe("sandbox");
	expect(response.headers.get("cache-control")).toBe("private, no-store");
}

describe("GET /api/artifacts/[id]", () => {
	test.each([
		["chain-hop-1.html", "text/html"],
		["chain-hop-1.html", "text/html; charset=utf-8"],
		["page.mhtml", "text/mhtml"],
		["evidence-manifest.json", "application/json"],
		["chain-hop-2.html", "application/octet-stream"],
		["logo.svg", "image/svg+xml"],
		["page.xhtml", "application/xhtml+xml"],
	])("serves %s (%s) as a download the browser never renders", async (name, mimeType) => {
		const { id, bytes } = await stored(name, mimeType);
		const response = await get(id);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(mimeType);
		expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${name}"; filename*=UTF-8''${name}`);
		expectHardened(response);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
	});

	test.each(["image/png", "image/jpeg", "image/webp", "IMAGE/PNG"])("shows a %s screenshot inline, still unsniffed and sandboxed", async (mimeType) => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const { id } = await stored("screenshot.png", mimeType, png);
		const response = await get(id);
		expect(response.headers.get("content-type")).toBe(mimeType);
		expect(response.headers.get("content-disposition")).toBe(`inline; filename="screenshot.png"; filename*=UTF-8''screenshot.png`);
		expectHardened(response);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
	});

	test("an artifact stored without a type or name is opaque bytes named artifact", async () => {
		const { id } = await stored(undefined, undefined);
		const response = await get(id);
		expect(response.headers.get("content-type")).toBe("application/octet-stream");
		expect(response.headers.get("content-disposition")).toBe(`attachment; filename="artifact"; filename*=UTF-8''artifact`);
		expectHardened(response);
	});

	test("a name with quotes, a line break and non-ASCII cannot break out of the header and keeps its exact form in filename*", async () => {
		const name = `Rechnung "Ä"\\\r\nSet-Cookie: x=1; 100% (echt)'*.html`;
		const { id } = await stored(name, "text/html");
		const disposition = (await get(id)).headers.get("content-disposition")!;
		expect(disposition).toBe(`attachment; filename="Rechnung ______Set-Cookie: x=1; 100_ (echt)'*.html"; filename*=UTF-8''Rechnung%20%22%C3%84%22%5C%0D%0ASet-Cookie%3A%20x%3D1%3B%20100%25%20%28echt%29%27%2A.html`);
		expect(disposition).not.toMatch(/[\r\n]/);
		const encoded = disposition.split("filename*=UTF-8''")[1]!;
		expect(encoded).toMatch(/^[A-Za-z0-9!#$&+\-.^_`|~%]+$/);
		expect(decodeURIComponent(encoded)).toBe(name);
	});

	test.each(["abc", "-1", "1.5", "", "123456789012345678901", "1 OR 1=1"])("answers 404 for the id %p", async (id) => {
		expect((await get(id)).status).toBe(404);
	});

	test("answers 404 for an artifact that does not exist", async () => {
		await stored("x.html", "text/html");
		expect((await get("999999")).status).toBe(404);
	});
});
