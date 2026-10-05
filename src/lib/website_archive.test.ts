import { describe, expect, test } from "bun:test";
import type { Browser, BrowserContext, HTTPRequest, HTTPResponse, Page } from "rebrowser-puppeteer-core";
import type { WebsiteNavigationHop } from "./website_types";

import { archiveWebsite, getMhtmlArchiveDate, getMhtmlArchiveLocation } from "./website_archive";

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

function responseForNavigation(
	url: string,
	status: number,
	options: { location?: string; contentType?: string; redirects?: Array<{ url: string; status: number; location?: string }> } = {},
): HTTPResponse {
	const response = (hopUrl: string, hopStatus: number, headers: Record<string, string>, redirects: HTTPRequest[]): HTTPResponse => {
		let hopResponse: HTTPResponse;
		const request = {
			url: () => hopUrl,
			response: () => hopResponse,
			redirectChain: () => redirects,
		} as unknown as HTTPRequest;
		hopResponse = {
			ok: () => hopStatus >= 200 && hopStatus < 300,
			status: () => hopStatus,
			url: () => hopUrl,
			headers: () => headers,
			request: () => request,
		} as HTTPResponse;
		return hopResponse;
	};
	const redirects = options.redirects ?? [];
	const priorRequests: HTTPRequest[] = [];
	for (const redirect of redirects) {
		const redirectResponse = response(redirect.url, redirect.status, {
			...(redirect.location ? { location: redirect.location } : {}),
			"content-type": "text/html",
		}, priorRequests.slice());
		const redirectRequest = {
			url: () => redirect.url,
			response: () => redirectResponse,
			redirectChain: () => priorRequests.slice(),
		} as unknown as HTTPRequest;
		priorRequests.push(redirectRequest);
	}
	return response(url, status, {
		...(options.location ? { location: options.location } : {}),
		...(options.contentType ? { "content-type": options.contentType } : {}),
	}, priorRequests) as HTTPResponse;
}

function archiveBrowserFixture(options: {
	goto?: (url: string, navigation: { waitUntil?: string; timeout?: number }) => Promise<HTTPResponse | null>;
	pageUrl?: string;
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
			return responseForNavigation(options.pageUrl ?? url, 200, { contentType: "text/html" });
		},
		screenshot: async () => { screenshotCount++; return Buffer.from("png"); },
		target: () => ({
			createCDPSession: async () => ({
				send: async (method: string) => {
					if (method !== "Page.captureSnapshot") throw new Error(`Unexpected CDP command ${method}`);
					captureSnapshotCount++;
					return {
						data: [
							"From: <Saved by Blink>",
							`Snapshot-Content-Location: ${options.pageUrl ?? "https://example.test/"}`,
							"Content-Type: multipart/related; boundary=\"archive-test\"",
							"",
							"--archive-test",
							"Content-Type: text/html",
							`Content-Location: ${options.pageUrl ?? "https://example.test/"}`,
							"",
							"<html><head><title>Captured title</title></head><body>Captured page text</body></html>",
							"--archive-test--",
						].join("\r\n"),
					};
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
		url: () => options.pageUrl ?? "https://example.test/",
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

test("website capture records every redirect response separately from the final page evidence", async () => {
	const requestedUrl = "https://share.google/ZAq2FghpGquJH6ShL";
	const googleUrl = "https://www.google.com/share.google?q=ZAq2FghpGquJH6ShL";
	const workerUrl = "https://dark-haze-3505.silo1.workers.dev/";
	const destinationUrl = "https://fuckyou.gay/";
	const fixture = archiveBrowserFixture({
		pageUrl: destinationUrl,
		goto: async () => responseForNavigation(destinationUrl, 200, {
			contentType: "text/html; charset=UTF-8",
			redirects: [
				{ url: requestedUrl, status: 302, location: googleUrl },
				{ url: googleUrl, status: 301, location: workerUrl },
				{ url: workerUrl, status: 302, location: destinationUrl },
			],
		}),
	});
	const archive = await archiveWebsite(
		{ url: requestedUrl },
		{ browser: fixture.browser },
	);

	expect(fixture.navigationCalls).toEqual([{ url: requestedUrl, waitUntil: "domcontentloaded", timeout: 30_000 }]);
	expect(fixture.interceptionEnabled).toBe(false);
	expect(fixture.eventNames).not.toContain("request");
	expect(fixture.eventNames).not.toContain("response");
	expect(archive.requestedUrl).toBe(requestedUrl);
	expect(archive.url).toBe(destinationUrl);
	expect(archive.hostname).toBe("fuckyou.gay");
	expect(archive.navigationHops).toEqual([
		{ index: 0, url: requestedUrl, hostname: "share.google", status: 302, redirectTo: googleUrl, contentType: "text/html", contentCaptured: false },
		{ index: 1, url: googleUrl, hostname: "www.google.com", status: 301, redirectTo: workerUrl, contentType: "text/html", contentCaptured: false },
		{ index: 2, url: workerUrl, hostname: "dark-haze-3505.silo1.workers.dev", status: 302, redirectTo: destinationUrl, contentType: "text/html", contentCaptured: false },
		{ index: 3, url: destinationUrl, hostname: "fuckyou.gay", status: 200, contentType: "text/html; charset=UTF-8", contentCaptured: true },
	]);
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
		{ browser: fixture.browser },
	)).rejects.toThrow("Navigation timeout of 30000 ms exceeded");
	expect(fixture.screenshotCount).toBe(1);
	expect(fixture.captureSnapshotCount).toBe(0);
	expect(fixture.closeCount).toBe(1);
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
