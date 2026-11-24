import { describe, expect, test } from "bun:test";

import type { WebsiteNavigationHop } from "../types";
import { archiveWebsite } from "./";
import { getMhtmlArchiveDate, getMhtmlArchiveLocation } from "./mhtml";

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

	test("reads the top-level document URL, not a MIME part URL", () => {
		const snapshot = Buffer.from([
			"From: <Saved by Blink>",
			"Snapshot-Content-Location: https://final.example/landing",
			"",
			"Content-Location: https://embedded.example/",
		].join("\r\n"), "latin1");
		expect(getMhtmlArchiveLocation(snapshot)).toBe("https://final.example/landing");
		expect(getMhtmlArchiveLocation(mhtml("Snapshot-Content-Location: file:///etc/passwd"))).toBeUndefined();
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

test("retrying retained MHTML preserves the submitted URL and exact captured-hop provenance", async () => {
	const requestedUrl = "https://share.google/ZAq2FghpGquJH6ShL";
	const finalUrl = "https://fuckyou.gay/";
	const navigationHops: WebsiteNavigationHop[] = [
		{ index: 0, url: requestedUrl, hostname: "share.google", status: 302, redirectTo: "https://www.google.com/", contentCaptured: false },
		{ index: 1, url: finalUrl, hostname: "fuckyou.gay", status: 200, contentCaptured: true },
	];
	const snapshot = Buffer.from([
		"From: <Saved by Blink>",
		`Content-Type: multipart/related; boundary="fabric-test"`,
		"",
		"--fabric-test",
		"Content-Type: text/html",
		"Content-Location: https://fuckyou.gay/",
		"",
		"<html><body>troll page</body></html>",
		"--fabric-test--",
	].join("\r\n"), "utf8");

	const archive = await archiveWebsite({ url: requestedUrl, archivedUrl: finalUrl, navigationHops, mhtmlSnapshot: snapshot });

	expect(archive.requestedUrl).toBe(requestedUrl);
	expect(archive.url).toBe(finalUrl);
	expect(archive.hostname).toBe("fuckyou.gay");
	expect(archive.navigationHops).toEqual(navigationHops);
	expect(archive.text.toString()).toContain("troll page");
});


test("legacy retained MHTML recovers its captured URL instead of assigning final content to the submitted shortener", async () => {
	const requestedUrl = "https://share.google/ZAq2FghpGquJH6ShL";
	const finalUrl = "https://fuckyou.gay/";
	const snapshot = Buffer.from([
		"From: <Saved by Blink>",
		`Snapshot-Content-Location: ${finalUrl}`,
		"Content-Type: multipart/related; boundary=\"fabric-test\"",
		"",
		"--fabric-test",
		"Content-Type: text/html",
		`Content-Location: ${finalUrl}`,
		"",
		"<html><body>troll page</body></html>",
		"--fabric-test--",
	].join("\r\n"), "utf8");

	const archive = await archiveWebsite({ url: requestedUrl, mhtmlSnapshot: snapshot, trustMhtmlDocumentLocation: true });

	expect(archive.requestedUrl).toBe(requestedUrl);
	expect(archive.url).toBe(finalUrl);
	expect(archive.hostname).toBe("fuckyou.gay");
	expect(archive.navigationHops).toEqual([
		{ index: 0, url: requestedUrl, hostname: "share.google", status: null, redirectTo: finalUrl, contentCaptured: false },
		{ index: 1, url: finalUrl, hostname: "fuckyou.gay", status: null, contentCaptured: true },
	]);
	expect(archive.text.toString()).toContain("troll page");
});


test("untrusted submitted MHTML cannot choose the URL associated with captured page evidence", async () => {
	const snapshot = Buffer.from([
		"From: <Saved by Blink>",
		"Snapshot-Content-Location: https://victim.example/login",
		"Content-Type: multipart/related; boundary=\"fabric-test\"",
		"",
		"--fabric-test",
		"Content-Type: text/html",
		"Content-Location: https://victim.example/login",
		"",
		"<html><body>untrusted uploaded snapshot</body></html>",
		"--fabric-test--",
	].join("\r\n"), "utf8");

	const archive = await archiveWebsite({ url: "https://submitter.example/", mhtmlSnapshot: snapshot });

	expect(archive.url).toBe("https://submitter.example/");
	expect(archive.navigationHops).toEqual([{
		index: 0,
		url: "https://submitter.example/",
		hostname: "submitter.example",
		status: null,
		contentCaptured: false,
	}]);
});
