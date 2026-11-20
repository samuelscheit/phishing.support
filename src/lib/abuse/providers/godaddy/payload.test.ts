import { describe, expect, test } from "bun:test";

import { reportReferencesIn } from "../report_reference";
import { GODADDY_PROVIDER as PROVIDER } from "./definition";
import { buildGoDaddySubmissionPayload, goDaddyBrand, goDaddyReportUrls, storedGoDaddySubmissionPayload, type GoDaddyReportInput } from "./payload";

const REFERENCE = "PS-8fc84cc01019-R7";
const description = "The page asks visitors for a password, sign-in details, a verification code, or identity details. Brand: ExampleBank";

export function input(overrides: Partial<GoDaddyReportInput> = {}): GoDaddyReportInput {
	return {
		target: "login-example-phish.com",
		observedUrls: ["https://login-example-phish.com/signin", "https://other.example/x"],
		description,
		allegationCategory: "phishing",
		legalBrandUrl: "https://www.examplebank.com/",
		trackingId: REFERENCE,
		caseUrl: "https://phishing.support/submissions/377486973465530391",
		hostingLine: "Hosting IP address: 203.0.113.7 (login-example-phish.com resolved to 203.0.113.7).",
		...overrides,
	};
}

describe("definition", () => {
	test("is pinned by a hash and names the mailbox, registrar and both channels", () => {
		expect(PROVIDER.contentHash).toMatch(/^[a-f0-9]{64}$/);
		expect(PROVIDER.exactMailboxes).toEqual(["abuse@godaddy.com"]);
		expect(PROVIDER.registrarIds).toEqual([146]);
		expect(PROVIDER.api.maximumUrls).toBe(5);
		expect(PROVIDER.portal.recaptcha).toMatchObject({ action: "submit_abuse_report", siteKey: "6Lcds5YsAAAAAOxWlnaB1W5e1KIAmk2AhXuUpe97" });
	});
});

describe("goDaddyReportUrls", () => {
	test("keeps the domain's URLs in order, deduplicated, at most five", () => {
		const many = Array.from({ length: 9 }, (_, index) => `https://aphish.com/p${index}`);
		expect(goDaddyReportUrls("aphish.com", [...many, many[0]!, "https://elsewhere.com/x"])).toEqual(many.slice(0, 5));
		expect(goDaddyReportUrls("aphish.com", ["https://aphish.com/x", "https://aphish.com/x", "https://bphish.com/"])).toEqual(["https://aphish.com/x"]);
	});

	test("falls back to the root page; refuses unusable URLs", () => {
		expect(goDaddyReportUrls("aphish.com", ["https://bphish.com/", "not a url"])).toEqual(["https://aphish.com/"]);
		expect(goDaddyReportUrls("aphish.com", [`https://aphish.com/${"x".repeat(2100)}`])).toEqual(["https://aphish.com/"]);
	});
});

describe("goDaddyBrand", () => {
	test("the analysis' brand, else the legal brand's host, else a neutral word; always bounded", () => {
		expect(goDaddyBrand("Impersonated brand: Example Bank", "https://www.other.com/")).toBe("Example Bank");
		expect(goDaddyBrand("no brand here", "https://www.examplebank.com/")).toBe("examplebank.com");
		expect(goDaddyBrand("no brand here", null)).toBe("Not specified");
		expect(goDaddyBrand("no brand here", "javascript:alert(1)")).toBe("Not specified");
		expect(goDaddyBrand(`Brand: ${"A".repeat(300)}`, null).length).toBeLessThanOrEqual(PROVIDER.brandMaximumLength);
	});
});

describe("buildGoDaddySubmissionPayload", () => {
	test("leads the text with the reference, then the narrative, hosting line and case page", () => {
		const payload = buildGoDaddySubmissionPayload(input())!;
		expect(payload.report).toMatchObject({ trackingId: REFERENCE, type: "PHISHING", brand: "ExampleBank", urls: ["https://login-example-phish.com/signin"], caseUrl: "https://phishing.support/submissions/377486973465530391" });
		expect(payload.report.info.startsWith(`Reference: ${REFERENCE}\n\n`)).toBeTrue();
		expect(payload.report.info).toContain("registered or hosted at GoDaddy");
		expect(payload.report.info).toContain("Hosting IP address: 203.0.113.7");
		expect(payload.report.info.endsWith("Case details and screenshots: https://phishing.support/submissions/377486973465530391")).toBeTrue();
		expect(payload.report.info.length).toBeLessThanOrEqual(PROVIDER.infoMaximumLength);
		expect(reportReferencesIn(payload.report.info)).toEqual([REFERENCE]);
	});

	test("a malware report is typed MALWARE; no case page leaves caseUrl null", () => {
		const payload = buildGoDaddySubmissionPayload(input({ allegationCategory: "malware", caseUrl: undefined }))!;
		expect(payload.report).toMatchObject({ type: "MALWARE", caseUrl: null });
		expect(payload.report.info).not.toContain("Case details");
	});

	test("refuses a bad reference, a non-domain target and an unusable description", () => {
		expect(buildGoDaddySubmissionPayload(input({ trackingId: "PS-1" }))).toBeUndefined();
		expect(buildGoDaddySubmissionPayload(input({ target: "203.0.113.7" }))).toBeUndefined();
		expect(buildGoDaddySubmissionPayload(input({ description: "  " }))).toBeUndefined();
		expect(buildGoDaddySubmissionPayload(input({ hostingLine: "h".repeat(400), caseUrl: "https://phishing.support/" }))).toBeDefined();
	});
});

describe("storedGoDaddySubmissionPayload", () => {
	const stored = () => JSON.parse(JSON.stringify(buildGoDaddySubmissionPayload(input())!)) as Record<string, any>;

	test("reads exactly what the builder wrote", () => {
		expect(storedGoDaddySubmissionPayload(stored())).toEqual(buildGoDaddySubmissionPayload(input())!);
	});

	test("rejects every drift from the pinned shape", () => {
		const mutations: Array<[string, (payload: Record<string, any>) => void]> = [
			["adapter", (p) => { p.adapter = "x"; }],
			["definition version", (p) => { p.definition.version = "old"; }],
			["definition hash", (p) => { p.definition.contentHash = "0".repeat(64); }],
			["domain not normalized", (p) => { p.target.domain = "Login-Example-Phish.com"; }],
			["reference", (p) => { p.report.trackingId = "nope"; }],
			["type", (p) => { p.report.type = "CHILD_ABUSE"; }],
			["empty brand", (p) => { p.report.brand = ""; }],
			["no urls", (p) => { p.report.urls = []; }],
			["six urls", (p) => { p.report.urls = Array.from({ length: 6 }, (_, i) => `https://aphish.com/${i}`); }],
			["duplicate urls", (p) => { p.report.urls = ["https://aphish.com/", "https://aphish.com/"]; }],
			["private url", (p) => { p.report.urls = ["http://127.0.0.1/"]; }],
			["info without reference lead", (p) => { p.report.info = "hello"; }],
			["info too long", (p) => { p.report.info = `Reference: ${REFERENCE}\n${"x".repeat(PROVIDER.infoMaximumLength)}`; }],
			["case url", (p) => { p.report.caseUrl = "ftp://x"; }],
			["case url missing", (p) => { delete p.report.caseUrl; }],
		];
		for (const [name, mutate] of mutations) {
			const payload = stored();
			mutate(payload);
			expect(storedGoDaddySubmissionPayload(payload), name).toBeUndefined();
		}
		expect(storedGoDaddySubmissionPayload(null)).toBeUndefined();
	});
});
