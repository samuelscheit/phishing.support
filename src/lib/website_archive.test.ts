import { describe, expect, test } from "bun:test";
import type { Browser, BrowserContext, Page } from "rebrowser-puppeteer-core";

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

function archiveBrowserFixture(options: {
	goto?: (url: string, navigation: { waitUntil?: string; timeout?: number }) => Promise<{ ok: () => boolean; status: () => number } | null>;
} = {}) {
	const eventNames: string[] = [];
	const navigationCalls: Array<{ url: string; waitUntil?: string; timeout?: number }> = [];
	let interceptionEnabled = false;
	let screenshotCount = 0;
	let closeCount = 0;
	let captureSnapshotCount = 0;
	const context = {} as BrowserContext;
	const page = {
		browser: () => browser,
		browserContext: () => context,
		setViewport: async () => undefined,
		on: (event: string) => { eventNames.push(event); },
		setRequestInterception: async (enabled: boolean) => { interceptionEnabled = enabled; },
		goto: async (url: string, navigation: { waitUntil?: string; timeout?: number }) => {
			navigationCalls.push({ url, ...navigation });
			if (options.goto) return options.goto(url, navigation);
			return { ok: () => true, status: () => 200 };
		},
		screenshot: async () => { screenshotCount++; return Buffer.from("png"); },
		target: () => ({
			createCDPSession: async () => ({
				send: async (method: string) => {
					if (method !== "Page.captureSnapshot") throw new Error(`Unexpected CDP command ${method}`);
					captureSnapshotCount++;
					return { data: "From: <Saved by Blink>\r\n\r\nMHTML evidence" };
				},
			}),
		}),
		evaluate: async (callback: () => unknown) => {
			const source = callback.toString();
			if (source.includes("cloneNode")) return "<html><body>Captured HTML</body></html>";
			if (source.includes("document.body.innerText")) return "Captured page text";
			if (source.includes("querySelector")) return "Captured description";
			throw new Error("Unexpected page evaluation");
		},
		title: async () => "Captured title",
	};
	const browser = {
		defaultBrowserContext: () => ({ ...context, newPage: async () => page }),
		close: async () => { closeCount++; },
	} as unknown as Browser;

	return {
		browser,
		page: page as unknown as Page & { setRequestInterception: (enabled: boolean) => Promise<void> },
		eventNames,
		navigationCalls,
		get interceptionEnabled() { return interceptionEnabled; },
		get screenshotCount() { return screenshotCount; },
		get closeCount() { return closeCount; },
		get captureSnapshotCount() { return captureSnapshotCount; },
	};
}

test("website capture commits at DOMContentLoaded without intercepting redirect requests", async () => {
	const fixture = archiveBrowserFixture();
	const archive = await archiveWebsite(
		{ url: "https://share.google/ZAq2FghpGquJH6ShL" },
		{ browser: fixture.browser, sleep: async () => undefined },
	);

	expect(fixture.navigationCalls).toEqual([{
		url: "https://share.google/ZAq2FghpGquJH6ShL",
		waitUntil: "domcontentloaded",
		timeout: 30_000,
	}]);
	expect(fixture.interceptionEnabled).toBe(false);
	expect(fixture.eventNames).not.toContain("request");
	expect(fixture.eventNames).not.toContain("response");
	expect(fixture.captureSnapshotCount).toBe(1);
	expect(fixture.screenshotCount).toBe(1);
	expect(fixture.closeCount).toBe(1);
	expect(archive.text.toString()).toContain("Captured page text");
});

test("website capture preserves navigation failures and closes the browser lease", async () => {
	const fixture = archiveBrowserFixture({
		goto: async () => { throw new Error("Navigation timeout of 30000 ms exceeded"); },
	});

	await expect(archiveWebsite(
		{ url: "https://example.test/" },
		{ browser: fixture.browser, sleep: async () => undefined },
	)).rejects.toThrow("Navigation timeout of 30000 ms exceeded");
	expect(fixture.screenshotCount).toBe(1);
	expect(fixture.captureSnapshotCount).toBe(0);
	expect(fixture.closeCount).toBe(1);
});
