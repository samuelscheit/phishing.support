import { describe, expect, test } from "bun:test";

import { AWS_PROVIDER } from "./definition";
import { awsEventTimestamp, awsReportUrls, awsRequestBody, buildAwsSubmissionPayload, storedAwsSubmissionPayload, type AwsReportInput } from "./payload";
import { reportReference, reportReferencesIn } from "../report_reference";
import { providerDefinitionHasValidHash } from "../kit/pin";

const TRACKING_ID = "PS-8fc84cc01019-R381763380685313515";
const input: AwsReportInput = {
	target: "login-example-phish.com",
	observedUrls: ["https://login-example-phish.com/signin", "https://login-example-phish.com/a?b=1#frag"],
	description: "The page asks visitors for a password, sign-in details, a verification code, or identity details.",
	allegationCategory: "phishing",
	legalBrandUrl: "https://www.examplebank.com/",
	trackingId: TRACKING_ID,
	caseUrl: "https://phishing.support/submissions/42",
};

describe("definition", () => {
	test("is pinned by its own hash", () => {
		expect(providerDefinitionHasValidHash(AWS_PROVIDER)).toBeTrue();
		expect(AWS_PROVIDER.reporter).toMatchObject({ firstName: "Phishing", lastName: "Support", email: "support@phishing.support", organization: "Phishing Support", description: "independent-researcher", phone: "" });
	});
});

describe("tracking id", () => {
	test("is the case tag and route, within the form's limit", () => {
		expect(reportReference(0x8fc84cc01019n, 381763380685313515n)).toBe(TRACKING_ID);
		const longest = reportReference(2n ** 64n - 1n, 2n ** 63n - 1n);
		expect(longest.length).toBeLessThanOrEqual(AWS_PROVIDER.trackingIdMaximumLength);
		expect(longest).toMatch(/^PS-[0-9a-f]{12}-R\d+$/);
	});

	test("is found in quoted mail, any case, once", () => {
		expect(reportReferencesIn(`Your original report:\nReference: ${TRACKING_ID}\n> reference: ps-8FC84CC01019-r1 ${TRACKING_ID}`)).toEqual([TRACKING_ID, "PS-8fc84cc01019-R1"]);
		expect(reportReferencesIn("[PS-8fc84cc01019] no route; PS-123-R4; xPS-8fc84cc01019-R4")).toEqual([]);
	});
});

describe("urls", () => {
	test("observed URLs are normalized for the target, deduplicated and capped at ten", () => {
		const many = Array.from({ length: 15 }, (_, index) => `https://login-example-phish.com/p${index}`);
		const urls = awsReportUrls("login-example-phish.com", [...many, many[0]!]);
		expect(urls).toHaveLength(10);
		expect(urls).toEqual(many.slice(0, 10));
		expect(awsReportUrls("login-example-phish.com", ["https://login-example-phish.com/a", "https://login-example-phish.com/a"])).toEqual(["https://login-example-phish.com/a"]);
	});

	test("URLs of other hosts, too long or unusable are dropped; the host's root is the fallback", () => {
		const tooLong = `https://login-example-phish.com/${"a".repeat(AWS_PROVIDER.urlMaximumLength)}`;
		expect(awsReportUrls("login-example-phish.com", ["https://other.example/x", tooLong, "not a url", "javascript:alert(1)"])).toEqual(["https://login-example-phish.com/"]);
		expect(awsReportUrls("login-example-phish.com", [])).toEqual(["https://login-example-phish.com/"]);
		const exact = `https://login-example-phish.com/${"a".repeat(AWS_PROVIDER.urlMaximumLength - "https://login-example-phish.com/".length)}`;
		expect(exact).toHaveLength(AWS_PROVIDER.urlMaximumLength);
		expect(awsReportUrls("login-example-phish.com", [tooLong, exact])).toEqual([exact]);
	});

	test("an IP target keeps its URLs; without one there is no site to report, so no root URL is made up", () => {
		expect(awsReportUrls("34.102.117.75", ["https://34.102.117.75/login"])).toEqual(["https://34.102.117.75/login"]);
		expect(awsReportUrls("34.102.117.75", [])).toBeUndefined();
		expect(awsReportUrls("2001:db8::1", [])).toBeUndefined();
		expect(awsReportUrls("not a host", [])).toBeUndefined();
	});
});

describe("buildAwsSubmissionPayload", () => {
	test("drafts the form values for a phishing report", () => {
		const payload = buildAwsSubmissionPayload(input)!;
		expect(payload).toMatchObject({
			adapter: "aws_report_v1",
			target: { normalizedTarget: "login-example-phish.com" },
			report: { abuseType: "phishing", trackingId: TRACKING_ID, urls: ["https://login-example-phish.com/signin", "https://login-example-phish.com/a?b=1"] },
		});
		const { comments } = payload.report;
		expect(comments.startsWith(`Reference: ${TRACKING_ID}\n\n`)).toBeTrue();
		expect(comments).toContain("A suspected phishing site using AWS resources is being reported for login-example-phish.com.");
		expect(comments).toContain("AWS Acceptable Use Policy");
		expect(comments).toContain("Impersonated brand: https://www.examplebank.com/");
		expect(comments).toContain("Case details and screenshots: https://phishing.support/submissions/42");
		// The preservation request is stated once, in the narrative.
		expect(comments.match(/suspend rather than delete/g)).toHaveLength(1);
	});

	test("a malware report files the malware type and reads as malware", () => {
		const payload = buildAwsSubmissionPayload({ ...input, allegationCategory: "malware", legalBrandUrl: null, description: "The page offers Setup_Tool.exe, which the sandbox flags as a trojan." })!;
		expect(payload.report.abuseType).toBe("malware-website");
		expect(payload.report.comments).toContain("malware distribution");
		expect(payload.report.comments).toContain("Setup_Tool.exe");
	});

	test("the hosting line is kept and the case line is left out without a case page", () => {
		const hostingLine = "Hosting IP address: 34.102.117.75 (a.example resolved to 34.102.117.75 on 2026-11-20; network Amazon)";
		const { caseUrl: _caseUrl, ...withoutCase } = input;
		const comments = buildAwsSubmissionPayload({ ...withoutCase, hostingLine })!.report.comments;
		expect(comments).toContain(hostingLine);
		expect(comments).not.toContain("Case details");
	});

	test("never emits angle brackets, whatever the text holds", () => {
		const payload = buildAwsSubmissionPayload({ ...input, description: "Impersonated brand: <b>Evil</b>. The login form <script>alert(1)</script> collects a password.", hostingLine: "Hosting IP address: 1.2.3.4 (network <Amazon>)" })!;
		expect(payload.report.comments).not.toMatch(/[<>]/);
	});

	test("stays within the comments limit with a very long description, hosting line and brand URL", () => {
		const description = `${"The login page collects a password and a bank card number. ".repeat(900)}`;
		const payload = buildAwsSubmissionPayload({ ...input, description, hostingLine: `Hosting IP address: 1.2.3.4 (${"x".repeat(5000)})`, legalBrandUrl: `https://www.examplebank.com/${"p".repeat(2000)}` })!;
		expect(payload.report.comments.length).toBeLessThanOrEqual(AWS_PROVIDER.commentsMaximumLength);
		expect(payload.report.comments).toContain("suspend rather than delete");
	});

	test("refuses an empty description, a bad target and a malformed tracking id", () => {
		expect(buildAwsSubmissionPayload({ ...input, description: "  " })).toBeUndefined();
		expect(buildAwsSubmissionPayload({ ...input, target: "not a host" })).toBeUndefined();
		expect(buildAwsSubmissionPayload({ ...input, trackingId: "PS-1" })).toBeUndefined();
		expect(buildAwsSubmissionPayload({ ...input, trackingId: `${TRACKING_ID}0000000000000000000000000000000` })).toBeUndefined();
	});
});

describe("storedAwsSubmissionPayload", () => {
	const payload = buildAwsSubmissionPayload(input)!;
	const clone = () => JSON.parse(JSON.stringify(payload));

	test("round-trips what the builder wrote", () => {
		expect(storedAwsSubmissionPayload(clone())).toEqual(payload);
	});

	test("rejects another adapter, narrative version and definition pin", () => {
		expect(storedAwsSubmissionPayload({ ...clone(), adapter: "aws_report_v0" })).toBeUndefined();
		expect(storedAwsSubmissionPayload({ ...clone(), definition: { ...payload.definition, contentHash: "0".repeat(64) } })).toBeUndefined();
		expect(storedAwsSubmissionPayload({ ...clone(), definition: { ...payload.definition, version: "1999-01-01" } })).toBeUndefined();
		expect(storedAwsSubmissionPayload(null)).toBeUndefined();
		expect(storedAwsSubmissionPayload("x")).toBeUndefined();
	});

	test("rejects tampered report fields", () => {
		const tamper = (change: (report: Record<string, unknown>) => void) => {
			const copy = clone();
			change(copy.report);
			return storedAwsSubmissionPayload(copy);
		};
		expect(tamper((report) => { report.abuseType = "trademark"; })).toBeUndefined();
		expect(tamper((report) => { report.trackingId = "PS-1-R1"; })).toBeUndefined();
		expect(tamper((report) => { report.urls = []; })).toBeUndefined();
		expect(tamper((report) => { report.urls = Array.from({ length: 11 }, (_, index) => `https://login-example-phish.com/${index}`); })).toBeUndefined();
		expect(tamper((report) => { report.urls = ["https://login-example-phish.com/a b"]; })).toBeUndefined();
		expect(tamper((report) => { report.urls = ["http://127.0.0.1/"]; })).toBeUndefined();
		expect(tamper((report) => { report.urls = [`https://login-example-phish.com/${"a".repeat(1100)}`]; })).toBeUndefined();
		expect(tamper((report) => { report.urls = [5]; })).toBeUndefined();
		expect(tamper((report) => { report.comments = ""; })).toBeUndefined();
		expect(tamper((report) => { report.comments = "x".repeat(10_001); })).toBeUndefined();
		expect(tamper((report) => { report.comments = "<script>"; })).toBeUndefined();
		expect(tamper((report) => { delete report.comments; })).toBeUndefined();
		const noTarget = clone();
		noTarget.target = {};
		expect(storedAwsSubmissionPayload(noTarget)).toBeUndefined();
	});

	test("drops fields it does not know", () => {
		const copy = clone();
		copy.report.extra = "x";
		expect(storedAwsSubmissionPayload(copy)).toEqual(payload);
	});
});

describe("request body", () => {
	test("is exactly the form's JSON, one event per URL at the minute of filing", () => {
		const payload = buildAwsSubmissionPayload(input)!;
		expect(awsRequestBody(payload, new Date("2026-11-20T11:02:59.999Z"))).toEqual({
			content: {
				message: {
					abuse_source: "aws-owned-resource",
					abuse_group: "web_content",
					abuse_type: "phishing",
					web_content_events: [
						{ web_content_url: "https://login-example-phish.com/signin", timestamp: "2026-11-20T11:02:00+00:00" },
						{ web_content_url: "https://login-example-phish.com/a?b=1", timestamp: "2026-11-20T11:02:00+00:00" },
					],
					comments: payload.report.comments,
					reporter: {
						first_name: "Phishing",
						last_name: "Support",
						email_address: "support@phishing.support",
						phone: "",
						organization: "Phishing Support",
						description: "independent-researcher",
						tracking_id: TRACKING_ID,
					},
				},
			},
		});
	});

	test("timestamps are minute-truncated UTC", () => {
		expect(awsEventTimestamp(new Date("2026-01-02T03:04:05.678Z"))).toBe("2026-01-02T03:04:00+00:00");
		expect(awsEventTimestamp(new Date("2026-12-31T23:59:59.999Z"))).toBe("2026-12-31T23:59:00+00:00");
		expect(awsEventTimestamp(new Date("2026-03-01T00:00:00.000Z"))).toBe("2026-03-01T00:00:00+00:00");
	});
});
