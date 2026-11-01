import { expect, test } from "bun:test";

import { SubmissionsEntity } from "./db/entities";
import { useTemporaryDatabase } from "./db/test_helpers";
import { getMailWebsiteUrls } from "./mail";
import { handOffMailLinks, parseMail } from "./mail_ai";
import { createWebsiteSubmission } from "./submissions/website";

useTemporaryDatabase();

const noOrigin = { getInfo: async () => ({ ip_rdaps: [] }) };

/** The body of submission 375160822747370869, as received. */
const SHARE_GOOGLE_EML = [
	"From: SKill Express <geostatgem@gmail.com>",
	"To: Recipient <recipient@example.test>",
	"Subject: Thank You for Contacting SKill Express",
	"MIME-Version: 1.0",
	'Content-Type: multipart/alternative; boundary="b"',
	"",
	"--b",
	"Content-Type: text/plain; charset=utf-8",
	"Content-Transfer-Encoding: quoted-printable",
	"",
	"Hi =D0=A3 =D0=B2=D0=B0=D1=81 https://share.=",
	"google/xnf72t40tx4fzvKM2 Kessler,",
	"Contact us at Geostatgem@gmail.com.",
	"--b",
	"Content-Type: text/html; charset=utf-8",
	"Content-Transfer-Encoding: quoted-printable",
	"",
	'<p>Hi <a href=3D"https://share.google/xnf72t40tx4fzvKM2" target=3D"_blank">https://share.google/xnf72t40tx4fzvKM2</a> Kessler,</p>',
	'<p><a href=3D"mailto:Geostatgem@gmail.com">Geostatgem@gmail.com</a></p>',
	"--b--",
	"",
].join("\r\n");

test("a link in both mail parts is one web page; mailto links are not pages", async () => {
	const mail = await parseMail(SHARE_GOOGLE_EML, noOrigin);
	expect(getMailWebsiteUrls(mail)).toEqual(["https://share.google/xnf72t40tx4fzvKM2"]);
});

test("a plain-text mail's URLs are found, without the sentence punctuation after them", async () => {
	const mail = await parseMail([
		"From: Sender <sender@example.test>",
		"Subject: Verify",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Verify now: https://kit.example.com/login?id=1. Or (https://bit.ly/AbC).",
		"",
	].join("\r\n"), noOrigin);
	expect(getMailWebsiteUrls(mail)).toEqual(["https://kit.example.com/login?id=1", "https://bit.ly/AbC"]);
});

test("images and stylesheets are not linked pages", () => {
	expect(getMailWebsiteUrls({
		text: "",
		html: '<img src="https://cdn.example.com/logo.png"><link href="https://cdn.example.com/a.css"><a href="javascript:void(0)">x</a><a href=" https://kit.example.com/ ">y</a>',
	})).toEqual(["https://kit.example.com/"]);
});

test("a share.google link opens its own case even after another share.google code was judged a prank", async () => {
	// Submission 362635609681956871: an earlier share.google code led to a troll page and was marked invalid.
	const prankId = await createWebsiteSubmission({ url: "https://share.google/ZAq2FghpGquJH6ShL" }, async () => undefined);
	await SubmissionsEntity.update(prankId, { status: "invalid" });

	const started: string[] = [];
	const mail = await parseMail(SHARE_GOOGLE_EML, noOrigin);
	const linked = await handOffMailLinks({
		mail,
		submissionId: 375160822747370869n,
		reporter: {},
		createWebsite: (options) => createWebsiteSubmission(options, async ({ url }) => started.push(url)),
	});

	expect(linked).toHaveLength(1);
	expect(linked[0]!.url).toBe("https://share.google/xnf72t40tx4fzvKM2");
	expect(linked[0]!.submissionId).not.toBe(prankId.toString());
	expect(started).toEqual(["https://share.google/xnf72t40tx4fzvKM2"]);
	const created = await SubmissionsEntity.get(BigInt(linked[0]!.submissionId));
	expect(created?.source).toBe("email:375160822747370869");
	expect(created?.dedupeKey).toBe("website-share.google/xnf72t40tx4fzvKM2");
});

test("a link that already has a case links that case; one failing link does not drop the others", async () => {
	const existingId = await createWebsiteSubmission({ url: "https://kit.example.com/login" }, async () => undefined);
	await SubmissionsEntity.update(existingId, { status: "reported" });

	const linked = await handOffMailLinks({
		mail: { text: "", html: '<a href="https://broken.example.com/">a</a><a href="https://kit.example.com/other">b</a>' } as Parameters<typeof handOffMailLinks>[0]["mail"],
		submissionId: 1n,
		reporter: {},
		createWebsite: async (options) => {
			if (options.url.includes("broken")) throw new Error("database is locked");
			return createWebsiteSubmission(options, async () => undefined);
		},
	});

	expect(linked).toEqual([{ url: "https://kit.example.com/other", submissionId: existingId.toString() }]);
});
