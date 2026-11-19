import { describe, expect, test } from "bun:test";

import { localeFromAcceptLanguage, pickLocale } from "./i18n";

describe("localeFromAcceptLanguage", () => {
	test("takes the supported language with the highest quality", () => {
		expect(localeFromAcceptLanguage("fr-FR,fr;q=0.9,de;q=0.8,en;q=0.7")).toBe("de");
		expect(localeFromAcceptLanguage("en-US,en;q=0.9,de;q=0.8")).toBe("en");
		expect(localeFromAcceptLanguage("de;q=0.5, en;q=0.6")).toBe("en");
	});
	test("keeps header order between equal qualities", () => {
		expect(localeFromAcceptLanguage("de-AT, en")).toBe("de");
	});
	test("ignores languages refused with q=0 and malformed qualities", () => {
		expect(localeFromAcceptLanguage("de;q=0, en;q=0.1")).toBe("en");
		expect(localeFromAcceptLanguage("de;q=abc")).toBeUndefined();
	});
	test("has no answer for missing or unsupported languages", () => {
		expect(localeFromAcceptLanguage(undefined)).toBeUndefined();
		expect(localeFromAcceptLanguage("")).toBeUndefined();
		expect(localeFromAcceptLanguage("vi-VN,vi;q=0.9,fr;q=0.8")).toBeUndefined();
		expect(localeFromAcceptLanguage("*")).toBeUndefined();
	});
});

describe("pickLocale", () => {
	test("an explicit query wins over cookie and header", () => {
		expect(pickLocale({ query: "de", cookie: "en", acceptLanguage: "en" })).toBe("de");
	});
	test("the cookie wins over the header", () => {
		expect(pickLocale({ query: undefined, cookie: "de", acceptLanguage: "en" })).toBe("de");
	});
	test("unknown query and cookie values fall through", () => {
		expect(pickLocale({ query: "xx", cookie: "fr", acceptLanguage: "de-CH" })).toBe("de");
		expect(pickLocale({ query: ["de"], cookie: null, acceptLanguage: null })).toBe("en");
	});
	test("English is the last resort", () => {
		expect(pickLocale({})).toBe("en");
	});
});
