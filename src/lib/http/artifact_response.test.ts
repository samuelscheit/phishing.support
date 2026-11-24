import { describe, expect, test } from "bun:test";

import { artifactResponse, contentDisposition } from "./artifact_response";

const artifact = (mimeType: string | null, name: string | null = "file") => ({ blob: Buffer.from("x"), mimeType, name });

describe("artifactResponse", () => {
	test("a public artifact is cached for good, a private one never", () => {
		expect(artifactResponse(artifact("text/plain"), { access: "public" }).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(artifactResponse(artifact("text/plain"), { access: "private" }).headers.get("cache-control")).toBe("private, no-store");
	});

	test("a charset is added to the stored type, and changes nothing about how it is shown", () => {
		const text = artifactResponse(artifact("text/plain"), { access: "private", charset: "utf-8" });
		expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(text.headers.get("content-disposition")).toStartWith("attachment;");
		expect(text.headers.get("content-security-policy")).toBe("sandbox");
	});

	test("only raster images are shown inline", () => {
		const shown = (mimeType: string) => artifactResponse(artifact(mimeType), { access: "public" }).headers.get("content-disposition")!.split(";")[0];
		expect(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/png; foo=bar"].map(shown)).toEqual(Array(6).fill("inline"));
		expect(["image/svg+xml", "image/x-icon", "text/html", "message/rfc822", "application/pdf", ""].map(shown)).toEqual(Array(6).fill("attachment"));
	});
});

describe("contentDisposition", () => {
	test("keeps an ASCII name as it is in both forms", () => {
		expect(contentDisposition("attachment", "evidence-step2-manifest.json")).toBe(`attachment; filename="evidence-step2-manifest.json"; filename*=UTF-8''evidence-step2-manifest.json`);
	});

	test("gives a non-ASCII name an ASCII stand-in and its UTF-8 bytes", () => {
		expect(contentDisposition("inline", "Bildschirmfoto 😀 ü.png")).toBe(`inline; filename="Bildschirmfoto _ _.png"; filename*=UTF-8''Bildschirmfoto%20%F0%9F%98%80%20%C3%BC.png`);
	});
});
