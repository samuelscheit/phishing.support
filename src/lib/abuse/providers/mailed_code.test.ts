import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { ALIBABA_CLOUD_PROVIDER } from "./alibaba_cloud/definition";
import { mailedCodeFrom, mailedCodeReader, type MailedCodeSpec } from "./mailed_code";

const realImapflow = await import("imapflow");

type FakeMessage = { uid: number; date?: Date; from: string; subject: string; html?: string; text?: string };

/** The mailbox the fake IMAP server serves, and what the reader asked of it. */
const server = {
	folders: {} as Record<string, FakeMessage[]>,
	searches: [] as Array<{ folder: string; query: Record<string, unknown> }>,
	sourceFetches: [] as number[][],
	locks: [] as Array<{ folder: string; readOnly?: boolean; released: boolean }>,
	loggedOut: 0,
	connected: 0,
};

function rfc822(message: FakeMessage): Buffer {
	const body = message.html ?? message.text ?? "";
	return Buffer.from([`From: <${message.from}>`, `Subject: ${message.subject}`, `Content-Type: ${message.html ? "text/html" : "text/plain"}; charset=utf-8`, "", body].join("\r\n"));
}

class FakeImapFlow {
	private folder = "";
	constructor(readonly options: unknown) {}
	async connect() { server.connected += 1; }
	async logout() { server.loggedOut += 1; }
	async getMailboxLock(folder: string, options?: { readOnly?: boolean }) {
		this.folder = folder;
		const lock = { folder, readOnly: options?.readOnly, released: false };
		server.locks.push(lock);
		return { release: () => { lock.released = true; } };
	}
	async search(query: Record<string, unknown>) {
		server.searches.push({ folder: this.folder, query });
		return (server.folders[this.folder] ?? []).map((message) => message.uid);
	}
	async *fetch(uids: number[], query: { source?: boolean }) {
		if (query.source) server.sourceFetches.push(uids);
		for (const message of server.folders[this.folder] ?? []) {
			if (!uids.includes(message.uid)) continue;
			yield { uid: message.uid, envelope: { date: message.date, from: [{ address: message.from }], subject: message.subject }, ...(query.source ? { source: rfc822(message) } : {}) };
		}
	}
}

const environment = { IMAP_HOST: "imap.test", IMAP_USER: "u", IMAP_PASS: "p", IMAP_MAILBOXES: "INBOX", IMAP_SHARED_MAILBOXES: "Shared", IMAP_LISTEN_ADDRESS: "inbox@replies.example.com", REPLY_DOMAIN: "replies.example.com" };
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
	mock.module("imapflow", () => ({ ...realImapflow, ImapFlow: FakeImapFlow }));
	for (const [name, value] of Object.entries(environment)) { saved[name] = process.env[name]; process.env[name] = value; }
});
afterAll(() => {
	mock.module("imapflow", () => realImapflow);
	for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});
beforeEach(() => {
	server.folders = {};
	server.searches = [];
	server.sourceFetches = [];
	server.locks = [];
	server.loggedOut = 0;
	server.connected = 0;
});

const alibaba = ALIBABA_CLOUD_PROVIDER.codeMail;
const ALIBABA_HTML = `<html><body><p>Dear sup****@phishing.support :</p><p>Please enter the code to verify your account.</p><p style="font-size:24px"><b>346070</b></p><p>Note: After your account is verified, you can log in. Ticket 998877 Phone 5550123 Year 2026</p></body></html>`;
const ALIBABA_FROM = "system-sg@notice.alibabacloud.com";
const ALIBABA_SUBJECT = "Verification Code from Alibaba Group";

describe("mailedCodeFrom with Alibaba Cloud's spec", () => {
	const mail = (overrides: Partial<{ from: string; subject: string; body: string }> = {}) => mailedCodeFrom(alibaba, { from: ALIBABA_FROM, subject: ALIBABA_SUBJECT, body: ALIBABA_HTML, ...overrides });

	test("extracts the code from the live mail", () => {
		expect(mail()).toBe("346070");
		// The mail as plain text, as the live one's text part reads.
		expect(mail({ body: "Dear sup****@phishing.support : Please enter the code to verify your account. 346070 Note: After your account ..." })).toBe("346070");
	});

	test("does not mistake the account's other numbers for the code", () => {
		expect(mail({ body: "Ticket 998877. Please enter the code to verify your account. 123456 Note: Year 202611, call 555012" })).toBe("123456");
		expect(mail({ body: "Case 998877 opened. Please enter the code to verify your account. Thanks" })).toBeUndefined();
		expect(mail({ body: "Please enter the code to verify your account. 12345 and 1234567" })).toBeUndefined();
		expect(mail({ body: "Please enter the code to verify your account. 3460701" })).toBeUndefined();
		expect(mail({ body: "Your login code is 346070" })).toBeUndefined();
	});

	test("tolerates markup, entities and line breaks between the sentence and the code", () => {
		expect(mail({ body: "<p>Please enter the code to verify your account.</p>\n\n<td>&nbsp;<b>346070</b></td>" })).toBe("346070");
		expect(mail({ body: "PLEASE ENTER THE CODE TO VERIFY YOUR ACCOUNT\n346070" })).toBe("346070");
	});

	test("accepts the sender's own domain and its subdomains, in any case, and nothing that merely resembles it", () => {
		expect(mail({ from: "system-sg@notice.alibabacloud.com" })).toBe("346070");
		expect(mail({ from: "system@alibabacloud.com" })).toBe("346070");
		expect(mail({ from: "System@Notice.AlibabaCloud.COM" })).toBe("346070");
		expect(mail({ from: "system@a.b.alibabacloud.com" })).toBe("346070");
		for (const from of ["system@alibabacloud.com.evil.example", "system@notalibabacloud.com", "system@alibabacloud.co", "system@evil.example", "alibabacloud.com", "", "system@notice.alibaba.com", "system@alibabacloud.com@evil.example"]) {
			expect(mail({ from })).toBeUndefined();
		}
	});

	test("needs the verification-code subject, case-insensitively", () => {
		expect(mail({ subject: "VERIFICATION CODE from Alibaba Group" })).toBe("346070");
		expect(mail({ subject: "Your Alibaba Cloud invoice" })).toBeUndefined();
		expect(mail({ subject: "" })).toBeUndefined();
	});
});

describe("mailedCodeReader against the mailbox", () => {
	const requestedAt = new Date("2026-11-20T10:00:00Z");
	const at = (offsetMs: number) => new Date(requestedAt.getTime() + offsetMs);
	const code = (uid: number, overrides: Partial<FakeMessage> = {}): FakeMessage => ({ uid, date: at(10_000), from: ALIBABA_FROM, subject: ALIBABA_SUBJECT, html: ALIBABA_HTML, ...overrides });
	const spec: MailedCodeSpec = { ...alibaba, waitMs: 200 };

	test("finds a code mailed from a subdomain: the IMAP search is by time only, the sender is matched from the envelope", async () => {
		server.folders.INBOX = [code(1)];
		await expect(mailedCodeReader(spec)(requestedAt)).resolves.toBe("346070");
		expect(server.searches).toHaveLength(1);
		const [{ query }] = server.searches;
		expect(Object.keys(query)).toEqual(["since"]);
		expect(query.since).toEqual(at(-60_000));
		// Read-only locks, always released, and the connection closed.
		expect(server.locks).toEqual([{ folder: "INBOX", readOnly: true, released: true }]);
		expect(server.loggedOut).toBe(1);
	});

	test("downloads only the mails whose sender matches", async () => {
		server.folders.INBOX = [
			code(1, { from: "promo@notalibabacloud.com" }),
			code(2, { from: "friend@gmail.com", subject: "Verification code", html: "Please enter the code to verify your account. 111111" }),
			code(3),
		];
		await expect(mailedCodeReader(spec)(requestedAt)).resolves.toBe("346070");
		expect(server.sourceFetches).toEqual([[3]]);
	});

	test("a lookalike sender's code is never returned", async () => {
		server.folders.INBOX = [code(1, { from: "system@alibabacloud.com.evil.example", html: "Please enter the code to verify your account. 666666" })];
		await expect(mailedCodeReader({ ...spec, waitMs: 1 })(requestedAt)).rejects.toThrow("did not arrive in time");
		expect(server.sourceFetches).toEqual([]);
		expect(server.loggedOut).toBe(1);
	}, 15_000);

	test("ignores mails from before the request (5 s slack) and after the maximum age, and takes the newest valid code", async () => {
		server.folders.INBOX = [
			code(1, { date: at(-6_000), html: "Please enter the code to verify your account. 100001" }),
			code(2, { date: at(-4_000), html: "Please enter the code to verify your account. 200002" }),
			code(3, { date: at(20_000), html: "Please enter the code to verify your account. 300003" }),
			code(4, { date: at(alibaba.maxAgeMs + 1_000), html: "Please enter the code to verify your account. 400004" }),
			code(5, { date: undefined, html: "Please enter the code to verify your account. 500005" }),
		];
		await expect(mailedCodeReader(spec)(requestedAt)).resolves.toBe("300003");
		expect(server.sourceFetches).toEqual([[2, 3]]);
	});

	test("a mail that is the right sender but not a code mail is skipped for an older real one", async () => {
		server.folders.INBOX = [code(1, { date: at(5_000) }), code(2, { date: at(30_000), subject: "Welcome to Alibaba Cloud", html: "<p>Welcome. Ticket 123456</p>" })];
		await expect(mailedCodeReader(spec)(requestedAt)).resolves.toBe("346070");
	});

	test("also searches the shared folders, where a code no rule filed lands", async () => {
		server.folders.INBOX = [];
		server.folders.Shared = [code(9)];
		await expect(mailedCodeReader(spec)(requestedAt)).resolves.toBe("346070");
		expect(server.locks.map(({ folder, released }) => ({ folder, released }))).toEqual([{ folder: "INBOX", released: true }, { folder: "Shared", released: true }]);
	});

	test("reads a plain-text-only mail", async () => {
		server.folders.INBOX = [code(1, { html: undefined, text: "Dear user: Please enter the code to verify your account. 424242 Note" })];
		await expect(mailedCodeReader(spec)(requestedAt)).resolves.toBe("424242");
	});

	test("an empty mailbox waits and then reports the missing code, naming the provider", async () => {
		await expect(mailedCodeReader({ ...spec, waitMs: 1 })(requestedAt)).rejects.toThrow("Alibaba Cloud's verification code did not arrive in time.");
		expect(server.loggedOut).toBe(1);
	}, 15_000);

	test("an aborted signal ends the wait with the abort reason, and the connection is closed", async () => {
		const controller = new AbortController();
		controller.abort(new Error("canceled by worker"));
		await expect(mailedCodeReader(spec)(requestedAt, controller.signal)).rejects.toThrow("canceled by worker");
		expect(server.loggedOut).toBe(1);
		expect(server.searches).toHaveLength(0);
	});

	test("without an IMAP mailbox configured it fails before connecting", async () => {
		const host = process.env.IMAP_HOST;
		delete process.env.IMAP_HOST;
		try {
			await expect(mailedCodeReader(spec)(requestedAt)).rejects.toThrow("requires the IMAP mailbox");
			expect(server.connected).toBe(0);
		} finally {
			process.env.IMAP_HOST = host;
		}
	});

	test("a spec with several sender domains matches any of them", async () => {
		server.folders.INBOX = [code(1, { from: "noreply@mail.other-sender.com", subject: "Verification code", html: "Please enter the code to verify your account. 777777" })];
		await expect(mailedCodeReader({ ...spec, senderDomains: ["alibabacloud.com", "other-sender.com"] })(requestedAt)).resolves.toBe("777777");
	});
});
