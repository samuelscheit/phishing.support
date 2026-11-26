import { describe, expect, test } from "bun:test";

import { screenshotCapturePage, websiteCaptureFileNames } from "./capture_files";

describe("screenshotCapturePage", () => {
	test("reads back the page of every screenshot name the capture writes", () => {
		for (const page of [{ route: 0, step: 0 }, { route: 0, step: 4 }, { route: 1, step: 0 }, { route: 11, step: 2 }]) {
			expect(screenshotCapturePage(websiteCaptureFileNames(page).screenshot)).toEqual(page);
		}
	});

	test("reads no page from names the capture never writes as a page's screenshot", () => {
		for (const name of ["website-stamped.png", "website-thumb.webp", "route1-website.png", "website-step1.png", "website-step0.png", "page.png", "website.png.png"]) {
			expect(screenshotCapturePage(name)).toBeUndefined();
		}
	});
});
