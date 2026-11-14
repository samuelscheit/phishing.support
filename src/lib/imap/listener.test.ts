import { afterEach, describe, expect, test } from "bun:test";

import { imapConfig } from "../mail_config";
import { addressedTo } from "./listener";

const names = ["IMAP_HOST", "IMAP_USER", "IMAP_PASS", "IMAP_MAILBOXES", "IMAP_SHARED_MAILBOXES", "IMAP_LISTEN_ADDRESS", "REPLY_DOMAIN"] as const;
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
afterEach(() => {
	for (const name of names) {
		if (original[name] === undefined) delete process.env[name];
		else process.env[name] = original[name];
	}
});

describe("shared mailboxes", () => {
	test("only mail whose To or Cc names a mailbox at the service domain is read from a shared folder", () => {
		// Discord's helpdesk answered a report's reply address; iCloud left it in the Inbox.
		expect(addressedTo({ to: [{ name: "", address: "Abuse-7de6b675d2fdc6bf155b8dad3d8ee693430eec5ba501158f@phishing.support" }] }, "phishing.support")).toBe(true);
		expect(addressedTo({ to: [{ address: "me@icloud.com" }], cc: [{ address: "abuse-1@phishing.support" }] }, "phishing.support")).toBe(true);
		// The owner's own mail, or a look-alike domain, is never read.
		expect(addressedTo({ to: [{ address: "me@icloud.com" }] }, "phishing.support")).toBe(false);
		expect(addressedTo({ to: [{ address: "x@notphishing.support" }, { address: "y@phishing.support.evil.example" }] }, "phishing.support")).toBe(false);
		expect(addressedTo({ to: [{ name: "phishing.support" }] }, "phishing.support")).toBe(false);
		expect(addressedTo(undefined, "phishing.support")).toBe(false);
	});

	test("shared folders are configured apart from the service's own, never twice", () => {
		Object.assign(process.env, {
			IMAP_HOST: "imap.mail.me.com",
			IMAP_USER: "owner",
			IMAP_PASS: "secret",
			IMAP_MAILBOXES: "phishing.support",
			IMAP_SHARED_MAILBOXES: "INBOX, phishing.support,INBOX",
			IMAP_LISTEN_ADDRESS: "report@phishing.support",
			REPLY_DOMAIN: "phishing.support",
		});
		expect(imapConfig()).toMatchObject({ mailboxes: ["phishing.support"], sharedMailboxes: ["INBOX"] });
		delete process.env.IMAP_SHARED_MAILBOXES;
		expect(imapConfig()).toMatchObject({ sharedMailboxes: [] });
	});
});
