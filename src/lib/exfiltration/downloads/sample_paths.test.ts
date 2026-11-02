import { describe, expect, test } from "bun:test";
import path from "node:path";

import { containedSamplePath, sampleArchiveRelativePath, sanitizeRemoteFilename } from "./sample_paths";

const HASH = "ab".repeat(32);
const ROOT = path.resolve("/tmp/phishing-samples-root");

describe("sample archive names", () => {
	test("derive from the hash with a two-level fan-out, never from a remote name", () => {
		expect(sampleArchiveRelativePath(HASH)).toBe(`ab/${HASH}.zip`);
	});

	test("refuse anything that is not a lowercase SHA-256", () => {
		for (const value of ["", "../../etc/passwd", "AB".repeat(32), "ab".repeat(31), `${HASH}/x`]) {
			expect(() => sampleArchiveRelativePath(value)).toThrow();
		}
	});
});

describe("containment under the sample store root", () => {
	test("resolves a normal relative archive inside the root", () => {
		expect(containedSamplePath(ROOT, `ab/${HASH}.zip`)).toBe(path.join(ROOT, "ab", `${HASH}.zip`));
	});

	test("refuses traversal, absolute paths, NUL bytes, and the root itself", () => {
		for (const relative of ["../escape.zip", "ab/../../escape.zip", "/etc/passwd", "ok\0.zip", "", "."]) {
			expect(() => containedSamplePath(ROOT, relative)).toThrow();
		}
	});

	test("refuses a relative root", () => {
		expect(() => containedSamplePath("relative/root", "a.zip")).toThrow("absolute");
	});

	test("a sibling directory that shares the root's prefix is still outside", () => {
		expect(() => containedSamplePath(ROOT, "../phishing-samples-root-evil/a.zip")).toThrow("escapes");
	});
});

describe("remote filename sanitization", () => {
	test("strips directory components from either separator", () => {
		expect(sanitizeRemoteFilename("..\\..\\Windows\\evil.exe")).toBe("evil.exe");
		expect(sanitizeRemoteFilename("/etc/passwd")).toBe("passwd");
	});

	test("normalizes a fullwidth solidus into a separator before splitting", () => {
		// U+FF0F FULLWIDTH SOLIDUS normalizes to "/" under NFKC, so the path is split there.
		expect(sanitizeRemoteFilename("..／..／evil.exe")).toBe("evil.exe");
	});

	test("removes control characters and leading dots", () => {
		expect(sanitizeRemoteFilename(".hidden\u0000.exe")).toBe("hidden.exe");
	});

	test("replaces characters outside a conservative set and caps the length", () => {
		expect(sanitizeRemoteFilename("Teams setup (x64)!.zip")).toBe("Teams setup _x64__.zip");
		expect(sanitizeRemoteFilename("a".repeat(300)).length).toBe(120);
	});

	test("falls back to a fixed name when nothing safe remains", () => {
		expect(sanitizeRemoteFilename(undefined)).toBe("sample.bin");
		expect(sanitizeRemoteFilename("....")).toBe("sample.bin");
	});
});
