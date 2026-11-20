import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { ALIBABA_SESSION_TTL_MS, alibabaCloudLoginConfig, buildAlibabaCloudSession, consoleSecToken, parseAlibabaCloudSession } from "./session";

describe("consoleSecToken", () => {
	test("reads the token from the console page's script", () => {
		expect(consoleSecToken(`<script>window.ALIYUN_CONSOLE_CONFIG = {\n  SEC_TOKEN: "Ak2GAMjWhLGnDwas6DsrS3",\n  FEATURE: true };</script>`)).toBe("Ak2GAMjWhLGnDwas6DsrS3");
		expect(consoleSecToken(`SEC_TOKEN : 'abc_DEF-12345678'`)).toBe("abc_DEF-12345678");
		expect(consoleSecToken(`{"SEC_TOKEN":"x"}`)).toBeUndefined();
	});

	test("refuses a missing, short, long or oddly-charactered token, and a longer property name", () => {
		expect(consoleSecToken("<html>login</html>")).toBeUndefined();
		expect(consoleSecToken(`SEC_TOKEN: ""`)).toBeUndefined();
		expect(consoleSecToken(`SEC_TOKEN: "short"`)).toBeUndefined();
		expect(consoleSecToken(`SEC_TOKEN: "${"a".repeat(129)}"`)).toBeUndefined();
		expect(consoleSecToken(`SEC_TOKEN: "${"a".repeat(128)}"`)).toBe("a".repeat(128));
		expect(consoleSecToken(`SEC_TOKEN: "abc def ghi jkl"`)).toBeUndefined();
		expect(consoleSecToken(`OLD_SEC_TOKEN: "Ak2GAMjWhLGnDwas6DsrS3"`)).toBeUndefined();
	});
});

describe("buildAlibabaCloudSession", () => {
	const cookies = [
		{ name: "cna", value: "c", domain: ".alibabacloud.com", path: "/", httpOnly: true } as never,
		{ name: "login_aliyunid_ticket", value: "ticket-1", domain: ".alibabacloud.com" },
	];

	test("needs the login ticket cookie", () => {
		expect(() => buildAlibabaCloudSession([], "Ak2GAMjWhLGnDwas6DsrS3", 0)).toThrow("missing login ticket");
		expect(() => buildAlibabaCloudSession([cookies[0]!], "Ak2GAMjWhLGnDwas6DsrS3", 0)).toThrow("missing login ticket");
		expect(() => buildAlibabaCloudSession([{ name: "login_aliyunid_ticket", value: "", domain: "x" }], "Ak2GAMjWhLGnDwas6DsrS3", 0)).toThrow("missing login ticket");
	});

	test("identifies the session by a hash of the ticket (never the ticket), keeps only name, value and domain, and expires after the bound", () => {
		const session = buildAlibabaCloudSession(cookies, "Ak2GAMjWhLGnDwas6DsrS3", 1_000);
		expect(session.id).toBe(createHash("sha256").update("ticket-1").digest("hex").slice(0, 32));
		expect(session.id).not.toContain("ticket-1");
		expect(session.expiresAt).toBe(1_000 + ALIBABA_SESSION_TTL_MS);
		expect(session.secToken).toBe("Ak2GAMjWhLGnDwas6DsrS3");
		expect(session.cookies).toEqual([{ name: "cna", value: "c", domain: ".alibabacloud.com" }, { name: "login_aliyunid_ticket", value: "ticket-1", domain: ".alibabacloud.com" }]);
		// A new ticket is a new session id (relogin invalidates the cached one).
		expect(buildAlibabaCloudSession([{ ...cookies[1]!, value: "ticket-2" }], "t".repeat(10), 0).id).not.toBe(session.id);
	});
});

describe("parseAlibabaCloudSession", () => {
	const valid = { id: "i", secToken: "s", expiresAt: 5, cookies: [{ name: "a", value: "b", domain: "c" }] };

	test("round-trips a stored session and drops extra fields", () => {
		expect(parseAlibabaCloudSession(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
		expect(parseAlibabaCloudSession({ ...valid, extra: 1, cookies: [{ ...valid.cookies[0], httpOnly: true }] })).toEqual(valid);
		expect(parseAlibabaCloudSession({ ...valid, cookies: [] })).toEqual({ ...valid, cookies: [] });
	});

	test("rejects every malformed shape", () => {
		for (const value of [
			undefined, null, 1, "x", [],
			{ ...valid, id: 1 }, { ...valid, secToken: undefined }, { ...valid, expiresAt: "5" }, { ...valid, cookies: "a" }, { ...valid, cookies: undefined },
			{ ...valid, cookies: [null] }, { ...valid, cookies: ["a=b"] },
			{ ...valid, cookies: [{ name: "a", value: "b" }] },
			{ ...valid, cookies: [{ name: "a", value: 2, domain: "c" }] },
			{ ...valid, cookies: [valid.cookies[0], { name: 1, value: "b", domain: "c" }] },
		]) expect(parseAlibabaCloudSession(value)).toBeUndefined();
	});
});

describe("alibabaCloudLoginConfig", () => {
	test("returns the trimmed email and the password untouched", () => {
		expect(alibabaCloudLoginConfig({ ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL: "  support@phishing.support ", ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD: " pw with space " })).toEqual({ email: "support@phishing.support", password: " pw with space " });
	});

	test("requires an email-shaped login and a non-empty password, naming the variable", () => {
		const password = "pw";
		for (const email of [undefined, "", "   ", "no-at-sign", "a@b", "a b@c.d", "@c.d", "a@@c.d"]) {
			expect(() => alibabaCloudLoginConfig({ ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL: email, ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD: password })).toThrow("ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL");
		}
		for (const bad of [undefined, ""]) expect(() => alibabaCloudLoginConfig({ ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL: "a@b.c", ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD: bad })).toThrow("ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD");
	});
});
