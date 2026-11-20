import { describe, expect, test } from "bun:test";

import { SubmissionsEntity } from "../../../db/entities/submissions";
import { useTemporaryDatabase } from "../../../db/test_helpers";
import { validateAbuseReportRequest } from "../../contracts";
import { AbuseRepository } from "../../repository";
import { contactRoute } from "../../resolver/routes";
import { reportConfirmedEmailPhishing } from "../../submission_reports";
import { parseEmailOrigin } from "../email_origin";
import { reportReference } from "../kit/report_reference";
import { AWS_PROVIDER } from "./definition";
import { awsEmailHeader, awsRequestBody, buildAwsSubmissionPayload, makeAwsEmailComments, storedAwsSubmissionPayload } from "./payload";
import { awsDraft, submitAwsSubmission } from "./submission";

useTemporaryDatabase();

const IP = "3.80.14.9";
const LINK = "https://evil-pay.example.org/renew?id=7";
const OTHER_LINK = "https://tracker.example.net/u/1";
const CASE = "https://phishing.support/submissions/42";
const TRACKING_ID = "PS-8fc84cc01019-R381763380685313515";
const RECEIVED_OLD = "Received: from relay.internal (relay.internal [10.0.0.4])\r\n\tby mx.example.net with ESMTP id abc; Thu, 19 Nov 2026 10:00:03 +0000";
const RECEIVED_HOP = `Received: from mail.sender.example (ec2-3-80-14-9.compute-1.amazonaws.com [${IP}])\r\n\tby mx.example.net (Postfix) with ESMTPS id 4F1\r\n\tfor <[redacted]>; Thu, 19 Nov 2026 10:00:01 +0100 (CET)`;
const HEADERS = [
	RECEIVED_OLD,
	RECEIVED_HOP,
	"From: Antivirus Billing <billing@sender.example>",
	"To: [redacted] <[redacted]>",
	"Subject: Your payment was declined",
	"X-Mailer: Foo onload=1 javascript:run()",
	"MIME-Version: 1.0",
	"Content-Type: multipart/alternative; boundary=b",
];
const BODY = ["", "--b", "Content-Type: text/plain; charset=utf-8", "", `Renew now: ${LINK} and ${OTHER_LINK}`, "--b--", ""];
const eml = [...HEADERS, ...BODY].join("\r\n");
const analysis = "- **Claimed brand:** Norton LifeLock. The email asks for a payment to renew an antivirus subscription and links to a page collecting card details.";
const capturedAt = new Date("2026-11-20T08:00:00.000Z");
const NOW = new Date("2026-11-20T11:02:41.500Z");
const FORM_HEADER = [
	"Received: from relay.internal (relay.internal [10.0.0.4])",
	"\tby mx.example.net with ESMTP id abc; Thu, 19 Nov 2026 10:00:03 +0000",
	`Received: from mail.sender.example (ec2-3-80-14-9.compute-1.amazonaws.com [${IP}])`,
	"\tby mx.example.net (Postfix) with ESMTPS id 4F1",
	"\tfor ＜[redacted]＞; Thu, 19 Nov 2026 10:00:01 +0100 (CET)",
	"From: Antivirus Billing ＜billing@sender.example＞",
	"To: [redacted] ＜[redacted]＞",
	"Subject: Your payment was declined",
	"X-Mailer: Foo on-load=1 javascript[colon]run()",
	"MIME-Version: 1.0",
	"Content-Type: multipart/alternative; boundary=b",
].join("\n");

const input = { target: IP, observedUrls: [], description: analysis, allegationCategory: "phishing", legalBrandUrl: "https://www.norton.com/", trackingId: TRACKING_ID, caseUrl: CASE, capturedAt };

describe("the header block the form is sent", () => {
	test("is the stored message's headers only, LF-joined, with the form's own sanitising", async () => {
		const origin = await parseEmailOrigin(eml, IP);
		expect(origin.headers).toBe(HEADERS.join("\r\n").replaceAll("\r\n", "\n"));
		expect(awsEmailHeader(origin.headers)).toBe(FORM_HEADER);
		expect(awsEmailHeader(origin.headers)).not.toContain("Renew now");
	});

	test("keeps the recipient redaction of the stored message and never any angle bracket", async () => {
		const header = awsEmailHeader((await parseEmailOrigin(eml, IP)).headers)!;
		expect(header).toContain("To: [redacted]");
		expect(header).not.toMatch(/[<>]/);
	});

	test("is cut at a whole line within the form's 10,000 characters, never inside one", () => {
		const lines = Array.from({ length: 400 }, (_, index) => `X-Filler-${index}: ${"a".repeat(40)}`);
		const header = awsEmailHeader(lines.join("\n"))!;
		expect(header.length).toBeLessThanOrEqual(AWS_PROVIDER.emailHeaderMaximumLength);
		expect(header.length).toBeGreaterThan(AWS_PROVIDER.emailHeaderMaximumLength - 100);
		expect(lines.join("\n").startsWith(header)).toBeTrue();
		expect(lines.join("\n")[header.length]).toBe("\n");
		const exact = "a".repeat(AWS_PROVIDER.emailHeaderMaximumLength);
		expect(awsEmailHeader(exact)).toBe(exact);
		expect(awsEmailHeader(`${exact}b`)).toBeUndefined();
		expect(awsEmailHeader("   \n  ")).toBeUndefined();
	});
});

describe("AWS email report for the IP that sent a phishing email", () => {
	test("is the form's Email category with the headers, the links, the hop and the case", async () => {
		const emailOrigin = await parseEmailOrigin(eml, IP);
		const payload = buildAwsSubmissionPayload({ ...input, emailOrigin })!;
		expect(payload.report).toMatchObject({ abuseGroup: "email", abuseType: "spam_send", urls: [LINK, OTHER_LINK], trackingId: TRACKING_ID, emailHeader: FORM_HEADER });
		const { comments } = payload.report;
		expect(comments.startsWith(`Reference: ${TRACKING_ID}\n\nA phishing email sent from AWS infrastructure at ${IP} is being reported.`)).toBeTrue();
		expect(comments).toContain("The email appears to impersonate Norton LifeLock");
		expect(comments).not.toContain("captured page");
		expect(comments).not.toContain("site using AWS resources");
		expect(comments).toContain([
			`Sending IP address: ${IP} (first external Received hop of a phishing email sent from it)`,
			`Received header: from mail.sender.example (ec2-3-80-14-9.compute-1.amazonaws.com [${IP}]) by mx.example.net (Postfix) with ESMTPS id 4F1 for <[redacted]>; Thu, 19 Nov 2026 10:00:01 +0100 (CET)`.replace(/[<>]/g, " "),
			"Date and time of the email: 2026-11-19T09:00:01Z (UTC)",
		].join("\n"));
		expect(comments.endsWith(`Phishing URLs in the email:\n- ${LINK}\n- ${OTHER_LINK}\n\nCase details and screenshots: ${CASE}`)).toBeTrue();
		expect(comments).not.toMatch(/[<>]/);
		expect(comments.length).toBeLessThanOrEqual(AWS_PROVIDER.commentsMaximumLength);
		expect(storedAwsSubmissionPayload(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
	});

	test("posts exactly the form's request: abuse_group email, an event per URL repeating the header, no web_content_events", async () => {
		const payload = buildAwsSubmissionPayload({ ...input, emailOrigin: await parseEmailOrigin(eml, IP) })!;
		const timestamp = "2026-11-20T11:02:00+00:00";
		const body = awsRequestBody(payload, NOW);
		expect(body).toEqual({
			content: {
				message: {
					abuse_source: "aws-owned-resource",
					abuse_group: "email",
					abuse_type: "spam_send",
					reporter: {
						first_name: "Phishing",
						last_name: "Support",
						email_address: "support@phishing.support",
						phone: "",
						organization: "Phishing Support",
						description: "independent-researcher",
						tracking_id: TRACKING_ID,
					},
					email_events: [
						{ email_header: FORM_HEADER, email_url: LINK, timestamp },
						{ email_header: FORM_HEADER, email_url: OTHER_LINK, timestamp },
					],
					comments: payload.report.comments,
				},
			},
		});
		expect(Object.keys(body.content.message)).not.toContain("web_content_events");
		// The form has no date, time zone or sender fields for this category: `email_for_abuse` is a honeypot it leaves empty.
		expect(JSON.stringify(body)).not.toMatch(/abuse_date|abuse_time|time_zone|email_for_abuse|logs/);
	});

	test("with no link sends one event with an empty URL, as the form does", async () => {
		const payload = buildAwsSubmissionPayload({ ...input, emailOrigin: { links: [], headers: FORM_HEADER } })!;
		expect(payload.report.urls).toEqual([]);
		expect(awsRequestBody(payload, NOW).content.message).toMatchObject({ email_events: [{ email_header: FORM_HEADER, email_url: "", timestamp: "2026-11-20T11:02:00+00:00" }] });
		expect(payload.report.comments).not.toContain("Phishing URLs in the email");
		expect(storedAwsSubmissionPayload(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
	});

	test("has no 30-day or date limit: an old email is filed, its time is in the comments, the event is stamped now", async () => {
		const old = eml.replace("Thu, 19 Nov 2026 10:00:01 +0100", "Mon, 01 Jun 2026 10:00:01 +0100");
		const origin = await parseEmailOrigin(old, IP);
		const payload = buildAwsSubmissionPayload({ ...input, emailOrigin: origin })!;
		expect(payload.report.comments).toContain("Date and time of the email: 2026-06-01T09:00:01Z (UTC)");
		expect(awsRequestBody(payload, NOW).content.message).toMatchObject({ email_events: [{ timestamp: "2026-11-20T11:02:00+00:00" }, { timestamp: "2026-11-20T11:02:00+00:00" }] });
	});

	test("falls back to the report time when no Received header states one", async () => {
		const origin = await parseEmailOrigin(eml.replace(IP, "198.51.100.9"), IP);
		expect(origin.received).toBeUndefined();
		const payload = buildAwsSubmissionPayload({ ...input, emailOrigin: origin })!;
		expect(payload.report.comments).toContain("Date and time of the email: 2026-11-20T08:00:00Z (UTC)");
	});

	test("holds at most ten links, valid and deduplicated; one too long for the form is dropped", () => {
		const many = Array.from({ length: 14 }, (_, index) => `https://l${index}.example.org/p`);
		const tooLong = `https://example.org/${"a".repeat(AWS_PROVIDER.urlMaximumLength)}`;
		const payload = buildAwsSubmissionPayload({ ...input, emailOrigin: { links: [tooLong, many[0]!, ...many, "https://a.example/with space"], headers: FORM_HEADER } })!;
		expect(payload.report.urls).toEqual(many.slice(0, 10));
		expect(payload.report.comments).not.toContain("aaaa");
	});

	test("keeps the comments within 10,000 characters, skipping links that do not fit", () => {
		const links = Array.from({ length: 10 }, (_, index) => `https://l${index}.example.org/${"x".repeat(1_000)}`);
		const comments = makeAwsEmailComments({ ...input, hostingLine: "h".repeat(600) }, { links, headers: FORM_HEADER }, capturedAt)!;
		expect(comments.length).toBeLessThanOrEqual(AWS_PROVIDER.commentsMaximumLength);
		expect(comments).toContain(`- ${links[0]}`);
		expect(comments).toContain(CASE);
		// A comments field with no room for the fixed parts is refused, not cut.
		expect(makeAwsEmailComments({ ...input, caseUrl: `https://phishing.support/${"c".repeat(10_000)}` }, { links: [], headers: FORM_HEADER }, capturedAt)).toBeUndefined();
	});

	test("is refused for a domain target, a malformed reference and an email with no header", async () => {
		const emailOrigin = await parseEmailOrigin(eml, IP);
		expect(buildAwsSubmissionPayload({ ...input, target: "sender.example", emailOrigin })).toBeUndefined();
		expect(buildAwsSubmissionPayload({ ...input, trackingId: "nope", emailOrigin })).toBeUndefined();
		expect(buildAwsSubmissionPayload({ ...input, emailOrigin: { links: [LINK], headers: "" } })).toBeUndefined();
	});

	test("the website path is unchanged: web_content, URLs, no header", () => {
		const payload = buildAwsSubmissionPayload({ ...input, target: "login-example-phish.com", observedUrls: ["https://login-example-phish.com/signin"] })!;
		expect(payload.report).toMatchObject({ abuseGroup: "web_content", abuseType: "phishing", urls: ["https://login-example-phish.com/signin"] });
		expect(payload.report.emailHeader).toBeUndefined();
		const body = awsRequestBody(payload, NOW).content.message as Record<string, unknown>;
		expect(body.abuse_group).toBe("web_content");
		expect(body.web_content_events).toEqual([{ web_content_url: "https://login-example-phish.com/signin", timestamp: "2026-11-20T11:02:00+00:00" }]);
		expect(body.email_events).toBeUndefined();
	});

	test("a stored draft is read only in the exact shape of its group", async () => {
		const payload = buildAwsSubmissionPayload({ ...input, emailOrigin: await parseEmailOrigin(eml, IP) })!;
		const stored = (change: (report: Record<string, unknown>) => void, target?: string) => {
			const copy = JSON.parse(JSON.stringify(payload));
			change(copy.report);
			if (target) copy.target.normalizedTarget = target;
			return storedAwsSubmissionPayload(copy);
		};
		expect(stored(() => undefined)).toEqual(payload);
		expect(stored((report) => { delete report.emailHeader; })).toBeUndefined();
		expect(stored((report) => { report.emailHeader = ""; })).toBeUndefined();
		expect(stored((report) => { report.emailHeader = "x".repeat(10_001); })).toBeUndefined();
		expect(stored((report) => { report.emailHeader = "To: <x@y.z>"; })).toBeUndefined();
		expect(stored((report) => { report.abuseType = "spam-website"; })).toBeUndefined();
		expect(stored((report) => { report.abuseType = "phishing"; })).toBeUndefined();
		expect(stored((report) => { report.abuseGroup = "network_activity"; })).toBeUndefined();
		expect(stored((report) => { delete report.abuseGroup; })).toBeUndefined();
		expect(stored(() => undefined, "sender.example")).toBeUndefined();
		expect(stored((report) => { report.urls = Array.from({ length: 11 }, (_, index) => `https://l${index}.example.org/`); })).toBeUndefined();
		// A web draft with a header, or without URLs, is not one.
		const web = buildAwsSubmissionPayload({ ...input, target: "login-example-phish.com", observedUrls: ["https://login-example-phish.com/signin"] })!;
		expect(storedAwsSubmissionPayload({ ...web, report: { ...web.report, emailHeader: "x" } })).toBeUndefined();
		expect(storedAwsSubmissionPayload({ ...web, report: { ...web.report, urls: [] } })).toBeUndefined();
	});
});

describe("AWS submission of a phishing email's sending IP", () => {
	async function ipRoute(createReport: () => Promise<bigint>) {
		const reportId = await createReport();
		const target = (await AbuseRepository.listTargets(reportId)).find((item) => item.targetType === "ip")!;
		const route = await AbuseRepository.upsertResolvedRoute(target.id, contactRoute({ email: "trustandsafety@support.aws.com", providerName: "AWS", provenance: {}, snapshot: {} }));
		return { reportId, route, report: await AbuseRepository.getReport(reportId) };
	}

	test("is prepared from the stored email of the report and posts the Email category", async () => {
		const { route, reportId } = await ipRoute(async () => {
			const submissionId = 382165893943136283n;
			await SubmissionsEntity.create({ id: submissionId, kind: "email", data: { kind: "email" }, dedupeKey: "aws-email-origin" });
			return (await reportConfirmedEmailPhishing({ submissionId, analysisText: analysis, redactedEml: eml, sendingIp: IP, reporter: {} })).reportId;
		});
		const preparation = await awsDraft.prepare({ routeId: route.id, payload: {} });
		if (preparation.outcome !== "ready") throw new Error(`Expected ready, got ${preparation.reason}`);
		const payload = storedAwsSubmissionPayload(preparation.payload)!;
		expect(payload.report).toMatchObject({ abuseGroup: "email", abuseType: "spam_send", urls: [LINK, OTHER_LINK], emailHeader: FORM_HEADER });
		expect(payload.report.comments).toContain(`Sending IP address: ${IP}`);
		expect(payload.report.comments).toContain("Date and time of the email: 2026-11-19T09:00:01Z (UTC)");
		expect(payload.report.comments).toContain("https://phishing.support/submissions/382165893943136283");
		expect(payload.report.trackingId).toBe(reportReference((await AbuseRepository.getReport(reportId))!.id, route.id));

		const sent: { url: string; body: any }[] = [];
		const success = await submitAwsSubmission(
			{ routeId: route.id, payload: payload as unknown as Record<string, unknown> },
			{ now: () => NOW, fetch: async (url, init) => { sent.push({ url, body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ data: { id: "case-1" } }), { status: 200 }); } },
		);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.url).toBe(AWS_PROVIDER.endpoint);
		expect(sent[0]!.body.content.message).toMatchObject({ abuse_group: "email", abuse_type: "spam_send", email_events: [{ email_header: FORM_HEADER, email_url: LINK }, { email_header: FORM_HEADER, email_url: OTHER_LINK }] });
		expect(success.submittedTargets).toEqual([IP]);
	});

	test("a bare IP, with no email and no observed URL, is insufficient evidence instead of a made-up https://ip/ site", async () => {
		const { route } = await ipRoute(async () => {
			const request = await validateAbuseReportRequest({ targets: [IP], allegationCategory: "phishing", description: analysis });
			return (await AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } })).reportId;
		});
		await expect(awsDraft.prepare({ routeId: route.id, payload: {} })).resolves.toEqual({ outcome: "insufficient_evidence", reason: "aws_requires_an_observed_url_or_the_phishing_email" });
	});

	test("an IP with an observed URL is still reported as a site", async () => {
		const { route } = await ipRoute(async () => {
			const request = await validateAbuseReportRequest({ targets: [IP], allegationCategory: "phishing", description: analysis, observedUrls: [{ target: IP, urls: [`https://${IP}/login`] }] });
			return (await AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } })).reportId;
		});
		const preparation = await awsDraft.prepare({ routeId: route.id, payload: {} });
		if (preparation.outcome !== "ready") throw new Error(`Expected ready, got ${preparation.reason}`);
		expect(storedAwsSubmissionPayload(preparation.payload)?.report).toMatchObject({ abuseGroup: "web_content", abuseType: "phishing", urls: [`https://${IP}/login`] });
	});
});
