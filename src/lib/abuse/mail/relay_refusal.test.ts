import { describe, expect, test } from "bun:test";

import { bodyWithoutLiveUrls, isRelayRefusal, reportPageUrl } from "./relay_refusal";

const dsn = (remote: string) => `Reporting-MTA: dns; outbound.ms.icloud.com\nFinal-Recipient: rfc822; abuse@registrar.eu\nAction: failed\nStatus: 5.7.1\nRemote-MTA: dns; ${remote}\nDiagnostic-Code: smtp; 550 5.7.1 [CS101] Message rejected due to local policy`;

describe("isRelayRefusal", () => {
	test("a refusal by a hop inside our relay (loopback or private address)", () => {
		for (const remote of ["127.0.0.1", "[127.0.0.1]", "localhost", "10.4.2.1", "172.20.0.3", "192.168.1.9", "::1", "fd00::5"]) expect(isRelayRefusal(dsn(remote))).toBe(true);
	});

	test("a refusal by the recipient's server, or a notification without the hop, is the provider's", () => {
		for (const remote of ["mx.registrar.eu", "203.0.113.7", "172.32.0.1", "2001:db8::1"]) expect(isRelayRefusal(dsn(remote))).toBe(false);
		expect(isRelayRefusal("Status: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 user unknown")).toBe(false);
		// The free-text part of the notice names 127.0.0.1 too; only the Remote-MTA field counts.
		expect(isRelayRefusal("<abuse@x.example>: host 127.0.0.1 said: 550 rejected\nRemote-MTA: dns; mx.x.example")).toBe(false);
	});

	test("the production notice, flattened to one line as it is stored", () => {
		expect(isRelayRefusal("<abuse@registrar.eu>: host 127.0.0.1[127.0.0.1] said: 550 5.7.1 [CS101] Message rejected due to local policy (in reply to end of DATA command) Reporting-MTA: dns; outbound.ms.icloud.com X-Postfix-Queue-ID: 40AAF180027E Final-Recipient: rfc822; *****@************ Original-Recipient: rfc822;abuse@registrar.eu Action: failed Status: 5.7.1 Remote-MTA: dns; 127.0.0.1 Diagnostic-Code: smtp; 550 5.7.1 [CS101] Message rejected")).toBe(true);
	});
});

describe("bodyWithoutLiveUrls", () => {
	const body = [
		"Hello Registrar.eu Abuse Team,",
		"",
		"Target: mediasolpharma.com",
		"Observed URLs:",
		"- https://mediasolpharma.com/read.html",
		"Impersonated/legitimate brand reference: https://accounts.google.com/",
		"Case details: https://phishing.support/submissions/381813325303911613",
		"",
		"Captured evidence indicates that https://mediasolpharma.com/read.html?u=a@b.c impersonates Google (see http://a9.micro-waves.com/e).",
		"",
		"Regards,",
		"The phishing.support team",
	].join("\n");

	test("every live address but ours becomes its bare host, and a note before the sign-off names the report's page", () => {
		const text = bodyWithoutLiveUrls(body, 42n);
		expect(text).not.toMatch(/https?:\/\/(?!phishing\.support)/);
		expect(text).toContain("- mediasolpharma.com\n");
		expect(text).toContain("brand reference: accounts.google.com");
		expect(text).toContain("indicates that mediasolpharma.com impersonates Google (see a9.micro-waves.com).");
		expect(text).toContain("Case details: https://phishing.support/submissions/381813325303911613");
		expect(text).toMatch(new RegExp(`listed on the report's page: ${reportPageUrl(42n).replaceAll(".", "\\.")}\\n\\nRegards,\\nThe phishing\\.support team$`));
		// Nothing is obfuscated: spam filters score that.
		expect(text).not.toMatch(/\[\.\]|hxxp/);
	});

	test("a body without foreign live addresses is left as it is", () => {
		const own = "Case details: https://phishing.support/reports/7\n\nRegards,\nThe phishing.support team";
		expect(bodyWithoutLiveUrls(own, 7n)).toBe(own);
	});

	test("without a sign-off the note goes at the end", () => {
		expect(bodyWithoutLiveUrls("See https://evil.example/x", 3n)).toBe(`See evil.example\n\nThe full addresses are left out of this email because our mail relay refused it with them; they are listed on the report's page: ${reportPageUrl(3n)}\n`);
	});
});

describe("migration 0022", () => {
	test("reclassifies the bounces our relay sent, and only those", () => {
		const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		const database = new Database(":memory:");
		database.exec("CREATE TABLE abuse_mail_messages (id integer PRIMARY KEY, kind text NOT NULL, classification text, disposition text, text_body text)");
		const insert = database.query("INSERT INTO abuse_mail_messages VALUES (?, ?, ?, ?, ?)");
		insert.run(1, "bounce", "bounce", "delivery_status_notification", `${dsn("127.0.0.1")}`.replaceAll("\n", " "));
		insert.run(2, "bounce", "bounce", "delivery_status_notification", dsn("mx.registrar.eu"));
		insert.run(3, "reply", "acknowledged", null, "Remote-MTA: dns; 127.0.0.1");
		insert.run(4, "bounce", "bounce", "delivery_status_notification", "host 127.0.0.1 said: 550 Status: 5.1.1");
		for (const statement of readFileSync("drizzle/0022_relay_refusals.sql", "utf-8").split("--> statement-breakpoint")) if (statement.trim()) database.exec(statement);
		expect(database.query("SELECT id, classification, disposition FROM abuse_mail_messages ORDER BY id").all()).toEqual([
			{ id: 1, classification: "relay_refused", disposition: "relay_refusal" },
			{ id: 2, classification: "bounce", disposition: "delivery_status_notification" },
			{ id: 3, classification: "acknowledged", disposition: null },
			{ id: 4, classification: "bounce", disposition: "delivery_status_notification" },
		]);
	});
});
