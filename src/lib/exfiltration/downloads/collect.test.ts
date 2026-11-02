import { describe, expect, test } from "bun:test";

import { collectDownloads } from "./collect";

const sha = "c".repeat(64);
const publicUrl = "https://storage.example.net/run/Teams-x64.zip";

describe("collecting Skyvern downloads from an untrusted run", () => {
	test("keeps a public HTTPS storage URL and its sanitized metadata", () => {
		const [file] = collectDownloads([{ url: publicUrl, filename: "Teams-x64.zip", checksum: sha }]);
		expect(file?.url.toString()).toBe(publicUrl);
		expect(file?.remoteName).toBe("Teams-x64.zip");
		expect(file?.reportedSha256).toBe(sha);
	});

	test("drops every non-HTTPS, credentialed, private, or malformed URL instead of repairing it", () => {
		const unsafe = [
			"http://storage.example.net/x.zip",
			"https://user:pass@storage.example.net/x.zip",
			"https://127.0.0.1/x.zip",
			"https://10.0.0.5/x.zip",
			"file:///etc/passwd",
			"javascript:alert(1)",
			"not a url",
			"",
		];
		for (const url of unsafe) {
			expect(collectDownloads([{ url, filename: "x.zip" }])).toEqual([]);
		}
	});

	test("ignores a checksum that is not a 64-hex SHA-256 rather than trusting it", () => {
		const [file] = collectDownloads([{ url: publicUrl, checksum: "not-a-hash" }]);
		expect(file?.reportedSha256).toBeUndefined();
	});

	test("never trusts a remote name for anything but display: it is returned unchanged for sanitizing later", () => {
		const [file] = collectDownloads([{ url: publicUrl, filename: "../../etc/passwd" }]);
		expect(file?.remoteName).toBe("../../etc/passwd");
	});

	test("caps the number of downloads taken from one run", () => {
		const many = Array.from({ length: 20 }, (_, index) => ({ url: `https://storage.example.net/${index}.zip` }));
		expect(collectDownloads(many)).toHaveLength(5);
	});

	test("a missing or non-array list yields no downloads and never throws", () => {
		expect(collectDownloads(undefined)).toEqual([]);
		expect(collectDownloads("https://storage.example.net/x.zip")).toEqual([]);
		expect(collectDownloads([null, 42, "string"])).toEqual([]);
	});
});
