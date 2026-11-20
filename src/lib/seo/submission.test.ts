import { describe, expect, test } from "bun:test";

import type { Submission } from "@/lib/db/schema";
import { truncateAtWord } from "../util/text";
import { submissionSeo } from "./submission";

const createdAt = new Date("2026-11-12T11:33:00Z");

function website(status: Submission["status"], extra: Partial<Extract<Submission["data"], { kind: "website" }>["website"]> = {}, info?: string): Submission {
	return { id: 1n, kind: "website", status, info, createdAt, data: { kind: "website", website: { url: "https://login.x-com.email/verify?u=1", ...extra } } } as Submission;
}

function email(status: Submission["status"], subject: string | undefined, info?: string): Submission {
	return { id: 2n, kind: "email", status, info, createdAt, data: { kind: "email", email: { subject } } } as Submission;
}

describe("submission page SEO", () => {
	test("a reported website is named by its host and called a confirmed phishing site, with what the analysis found", () => {
		const seo = submissionSeo(website("reported", {}, "Phishing confirmed at https://login.x-com.email/verify; its evidence is being collected before the report is sent."));
		// The host as searched for: "is login.x-com.email a scam".
		expect(seo).toEqual({
			subject: "login.x-com.email",
			verdict: "Confirmed phishing site",
			tone: "danger",
			title: "Is login.x-com.email a scam? Confirmed phishing site",
			description: "login.x-com.email is a phishing site, reported for takedown. Checked on 2026-11-12 by Phishing Support. Phishing confirmed at…",
		});
		expect(seo.description.length).toBeLessThanOrEqual(160);
	});

	test("a failed or running case's technical status text stays out of its description", () => {
		expect(submissionSeo(website("failed", {}, "Failed to load page: net::ERR_TUNNEL_CONNECTION_FAILED")).description).toBe("login.x-com.email could not be fully checked. Checked on 2026-11-12 by Phishing Support.");
		expect(submissionSeo(website("running", {}, "Collecting bounded WHOIS, RDAP, and regional DNS evidence.")).description).toBe("login.x-com.email is being checked for phishing. Checked on 2026-11-12 by Phishing Support.");
	});

	test("a malware finding is named as such", () => {
		expect(submissionSeo(website("reported", { siteAssessments: [{ hopIndex: 0, finding: "malware" }] as never })).verdict).toBe("Confirmed malware site");
	});

	test("every status gets its own verdict and tone", () => {
		expect(["invalid", "redirected", "failed", "running"].map((status) => {
			const { verdict, tone } = submissionSeo(website(status as Submission["status"]));
			return `${status}: ${verdict} (${tone})`;
		})).toEqual([
			"invalid: No phishing found (safe)",
			"redirected: Redirects to another site (neutral)",
			"failed: Check inconclusive (neutral)",
			"running: Check in progress (pending)",
		]);
	});

	test("an email is named by its subject, cut to fit, and one without a subject still reads", () => {
		const long = "Your Microsoft 365 password expires today – confirm your account to keep access to your mailbox and files";
		const seo = submissionSeo(email("reported", long));
		expect(seo.title).toBe("“Your Microsoft 365 password expires today – confirm your…” – Confirmed phishing email");
		expect(seo.description).toBe("The email “Your Microsoft 365 password expires today – confirm your account to…” is a phishing email, reported to the sender's providers. Checked on…");
		expect(submissionSeo(email("invalid", "  ")).title).toBe("“Email without a subject” – No phishing found");
	});

	test("text is cut at a word boundary without trailing punctuation", () => {
		expect(truncateAtWord("short", 10, { ellipsis: true })).toBe("short");
		expect(truncateAtWord("one two three, four five", 16, { ellipsis: true })).toBe("one two three…");
		expect(truncateAtWord("  spaced\n\nout   text  ", 40, { ellipsis: true })).toBe("spaced out text");
		// A single long word is cut inside it rather than dropped.
		expect(truncateAtWord("a".repeat(30), 10, { ellipsis: true })).toBe(`${"a".repeat(9)}…`);
	});
});
