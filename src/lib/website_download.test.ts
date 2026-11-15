import { describe, expect, test } from "bun:test";

import { downloadFileName, isDownloadResponse } from "./website_download";

describe("download file names", () => {
	test("the server's name wins, then the browser's suggestion, then the URL's last segment", () => {
		expect(downloadFileName("https://h.example/x", "attachment; filename*=UTF-8''Game%20Copier.zip; filename=\"fallback.zip\"")).toBe("Game Copier.zip");
		expect(downloadFileName("https://h.example/x", "attachment; filename=\"Setup.exe\"")).toBe("Setup.exe");
		expect(downloadFileName("blob:https://h.example/uuid", undefined, "fix.ps1")).toBe("fix.ps1");
		expect(downloadFileName("https://h.example/files/Game-Copier.zip?v=2", undefined)).toBe("Game-Copier.zip");
		expect(downloadFileName("https://h.example/", undefined)).toBe("download");
		expect(downloadFileName("https://h.example/x", "attachment; filename=\"../../etc/passwd\"")).toBe(".._.._etc_passwd");
	});
});

describe("which responses are downloads", () => {
	const response = (status: number, headers: Record<string, string>) => ({ responseStatusCode: status, responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })) });

	test("an attachment, or a document that is not a page, is saved rather than shown", () => {
		expect(isDownloadResponse(response(200, { "Content-Type": "application/zip" }))).toBeTrue();
		expect(isDownloadResponse(response(200, { "content-type": "application/octet-stream" }))).toBeTrue();
		expect(isDownloadResponse(response(200, { "content-type": "text/html", "content-disposition": "attachment; filename=\"fix.hta\"" }))).toBeTrue();
	});

	test("a page, a picture, a PDF a browser shows, or a failed response is not", () => {
		expect(isDownloadResponse(response(200, { "content-type": "text/html; charset=utf-8" }))).toBeFalse();
		expect(isDownloadResponse(response(200, { "content-type": "image/png" }))).toBeFalse();
		expect(isDownloadResponse(response(200, { "content-type": "application/pdf" }))).toBeFalse();
		expect(isDownloadResponse(response(200, {}))).toBeFalse();
		expect(isDownloadResponse(response(404, { "content-type": "application/zip" }))).toBeFalse();
		expect(isDownloadResponse(response(302, { "content-type": "application/zip" }))).toBeFalse();
	});
});
