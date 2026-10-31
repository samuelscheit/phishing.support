import { describe, expect, test } from "bun:test";

import { isSameWebsite, websiteSite, websiteSiteName } from "./website_site";

describe("website site identity", () => {
	test("an ordinary host is one site whatever the path", () => {
		expect(websiteSite("https://login-netflix.example.com/signin?x=1")).toBe("login-netflix.example.com");
		expect(isSameWebsite("http://kit.example.com/", "https://kit.example.com/login")).toBe(true);
		expect(isSameWebsite("https://kit.example.com/", "https://www.kit.example.com/")).toBe(false);
	});

	test("each Google Sites site is its own site", () => {
		expect(websiteSite("https://sites.google.com/view/revert-change")).toBe("sites.google.com/view/revert-change");
		expect(websiteSite("https://sites.google.com/view/Revert-Change/home?authuser=0")).toBe("sites.google.com/view/revert-change");
		expect(websiteSite("https://sites.google.com/example.org/intranet/page")).toBe("sites.google.com/example.org/intranet");
		expect(isSameWebsite("https://sites.google.com/view/revert-change", "https://sites.google.com/view/start-trezor-suite")).toBe(false);
		expect(isSameWebsite("https://sites.google.com/view/revert-change", "https://sites.google.com/view/revert-change/login")).toBe(true);
	});

	test("the platform's own pages without a tenant path stay the bare host", () => {
		expect(websiteSite("https://sites.google.com/")).toBe("sites.google.com");
		expect(websiteSite("https://bit.ly")).toBe("bit.ly");
	});

	test("Docs, Drive and Apps Script documents are told apart by their IDs", () => {
		expect(websiteSite("https://docs.google.com/forms/d/e/1FAIpQL-abc/viewform")).toBe("docs.google.com/forms/d/e/1FAIpQL-abc");
		expect(websiteSite("https://docs.google.com/forms/d/1AbC/edit")).toBe("docs.google.com/forms/d/1AbC");
		expect(websiteSite("https://docs.google.com/presentation/d/1XyZ/pub")).toBe("docs.google.com/presentation/d/1XyZ");
		expect(websiteSite("https://drive.google.com/file/d/1Qr/view")).toBe("drive.google.com/file/d/1Qr");
		expect(websiteSite("https://script.google.com/macros/s/AKfy/exec")).toBe("script.google.com/macros/s/AKfy");
	});

	test("short links and buckets keep their case-sensitive codes", () => {
		expect(websiteSite("https://bit.ly/AbC")).toBe("bit.ly/AbC");
		expect(isSameWebsite("https://bit.ly/AbC", "https://bit.ly/abc")).toBe(false);
		expect(websiteSite("https://storage.googleapis.com/savelinge/clearpath.html#frag")).toBe("storage.googleapis.com/savelinge");
		expect(websiteSite("https://github.com/Evil/repo/blob/main/x")).toBe("github.com/evil");
	});

	test("display names never throw on stored garbage", () => {
		expect(websiteSiteName(undefined)).toBeNull();
		expect(websiteSiteName("not a url")).toBeNull();
		expect(websiteSiteName("https://sites.google.com/view/x")).toBe("sites.google.com/view/x");
	});
});
