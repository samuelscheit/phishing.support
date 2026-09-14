import { describe, expect, test } from "bun:test";
import { archiveWebsite, getMhtmlArchiveDate } from "./website_archive";

function mhtml(preamble: string, body = "content") {
	return Buffer.from(`${preamble}\r\n\r\n${body}`, "latin1");
}

describe("getMhtmlArchiveDate", () => {
	test("reads the top-level capture date", () => {
		const date = getMhtmlArchiveDate(
			mhtml(
				["From: <Saved by Blink>", "Snapshot-Content-Location: https://example.test/", "Date: Tue, 13 Jan 2026 14:50:56 +0100"].join(
					"\r\n",
				),
			),
		);

		expect(date?.toISOString()).toBe("2026-01-13T13:50:56.000Z");
	});

	test("folds continuation lines and ignores dates inside MIME parts", () => {
		const date = getMhtmlArchiveDate(
			mhtml(
				["From: <Saved by Blink>", "Date:", "\tTue, 13 Jan 2026 14:50:56 +0100"].join("\r\n"),
				"Date: Wed, 14 Jan 2026 14:50:56 +0100",
			),
		);

		expect(date?.toISOString()).toBe("2026-01-13T13:50:56.000Z");
	});

	test("accepts LF-only MHTML headers", () => {
		const date = getMhtmlArchiveDate(Buffer.from("Date: Tue, 13 Jan 2026 14:50:56 +0100\n\ncontent", "latin1"));

		expect(date?.toISOString()).toBe("2026-01-13T13:50:56.000Z");
	});

	test("returns undefined when the capture date is absent or invalid", () => {
		expect(getMhtmlArchiveDate(mhtml("From: <Saved by Blink>"))).toBeUndefined();
		expect(getMhtmlArchiveDate(mhtml("Date: not a date"))).toBeUndefined();
	});
});

test("archiveWebsite parses a retained MHTML snapshot locally without opening a browser", async () => {
	const snapshot = Buffer.from([
		"From: <Saved by Blink>",
		"Content-Type: multipart/related; boundary=\"fabric-test\"",
		"",
		"--fabric-test",
		"Content-Type: text/html",
		"Content-Location: https://example.test/",
		"",
		"<html><head><title>Captured</title></head><body><p>Captured evidence</p><script>not-run()</script></body></html>",
		"--fabric-test--",
	].join("\r\n"), "utf8");

	const archive = await archiveWebsite({ url: "https://example.test/", mhtmlSnapshot: snapshot });
	expect(archive.html.toString()).toContain("Captured");
	expect(archive.text.toString()).toContain("Captured evidence");
	expect(archive.html.toString()).not.toContain("not-run");
	expect(archive.screenshotPng).toBeUndefined();
});
