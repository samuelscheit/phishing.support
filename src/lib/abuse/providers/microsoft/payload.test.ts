import { describe, expect, test } from "bun:test";

import { providerDefinitionHasValidHash } from "../definition";
import { MICROSOFT_PROVIDER } from "./definition";
import { buildMicrosoftSubmissionPayload, microsoftObservationTime, microsoftReportUrls, microsoftRequestBody, storedMicrosoftSubmissionPayload, type MicrosoftReportInput } from "./payload";

const REFERENCE = "PS-8fc84cc01019-R381763380685313515";
const input: MicrosoftReportInput = {
	target: "login-example-phish.azurewebsites.net",
	observedUrls: ["https://login-example-phish.azurewebsites.net/signin", "https://login-example-phish.azurewebsites.net/a?b=1#frag"],
	description: "The page asks visitors for a password, sign-in details, a verification code, or identity details.",
	allegationCategory: "phishing",
	legalBrandUrl: "https://www.examplebank.com/",
	reference: REFERENCE,
	caseUrl: "https://phishing.support/submissions/42",
	hostingLine: "Hosting IP address: 20.50.1.2 (login-example-phish.azurewebsites.net resolved to 20.50.1.2)",
};

describe("definition", () => {
	test("is pinned by its own hash and names the reviewed channel", () => {
		expect(providerDefinitionHasValidHash(MICROSOFT_PROVIDER)).toBeTrue();
		expect(MICROSOFT_PROVIDER).toMatchObject({ key: "microsoft_msrc", exactMailboxes: ["abuse@microsoft.com", "cert@microsoft.com"], supplemental: false, endpoint: "https://api.msrc.microsoft.com/report/v3.0/abuse" });
		expect(MICROSOFT_PROVIDER.reporter).toEqual({ name: "Phishing Support", email: "support@phishing.support", organization: "Phishing Support", phoneNumber: "" });
		expect(MICROSOFT_PROVIDER.reporter.email.length).toBeLessThanOrEqual(MICROSOFT_PROVIDER.reporterEmailMaximumLength);
		expect(MICROSOFT_PROVIDER.reporter.email).toMatch(/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i);
	});
});

describe("urls", () => {
	test("are normalized for the target, deduplicated and capped at ten", () => {
		const many = Array.from({ length: 15 }, (_, index) => `https://x.azurewebsites.net/p${index}`);
		const urls = microsoftReportUrls("x.azurewebsites.net", [...many, many[0]!]);
		expect(urls).toEqual(many.slice(0, 10));
	});

	test("URLs the form would split or refuse are dropped; the host's root is the fallback", () => {
		const long = `https://x.azurewebsites.net/${"a".repeat(MICROSOFT_PROVIDER.urlMaximumLength)}`;
		expect(microsoftReportUrls("x.azurewebsites.net", ["https://x.azurewebsites.net/a,b", "https://x.azurewebsites.net/a?x=1;y=2", "https://x.azurewebsites.net/a|b", long, "https://other.example/x", "javascript:alert(1)"])).toEqual(["https://x.azurewebsites.net/"]);
		expect(microsoftReportUrls("x.azurewebsites.net", ["https://x.azurewebsites.net/ok"])).toEqual(["https://x.azurewebsites.net/ok"]);
		expect(microsoftReportUrls("20.50.1.2", [])).toBeUndefined();
		expect(microsoftReportUrls("20.50.1.2", ["https://20.50.1.2/login"])).toEqual(["https://20.50.1.2/login"]);
		expect(microsoftReportUrls("not a host", [])).toBeUndefined();
	});
});

describe("buildMicrosoftSubmissionPayload", () => {
	test("drafts the form values for a phishing report", () => {
		const payload = buildMicrosoftSubmissionPayload(input)!;
		expect(payload).toMatchObject({
			adapter: "microsoft_msrc_report_v1",
			target: { normalizedTarget: input.target },
			report: { incidentType: "Phishing", reference: REFERENCE, urls: ["https://login-example-phish.azurewebsites.net/signin", "https://login-example-phish.azurewebsites.net/a?b=1"] },
		});
		const { notes } = payload.report;
		expect(notes.startsWith(`Reference: ${REFERENCE}\n\n`)).toBeTrue();
		expect(notes).toContain("hosted on Microsoft services");
		expect(notes).toContain("Impersonated brand: https://www.examplebank.com/");
		expect(notes).toContain("Hosting IP address: 20.50.1.2");
		expect(notes).toContain("Case details and screenshots: https://phishing.support/submissions/42");
		expect(notes.length).toBeLessThanOrEqual(MICROSOFT_PROVIDER.notesMaximumLength);
		expect(notes.match(/suspend rather than delete/g)).toHaveLength(1);
	});

	test("a malware report files the Malware incident type", () => {
		const payload = buildMicrosoftSubmissionPayload({ ...input, allegationCategory: "malware", description: "The page serves a payload that downloads malware: sha256 abc, detected by several engines." })!;
		expect(payload.report.incidentType).toBe("Malware");
		expect(payload.report.notes).toContain("malware distribution");
	});

	test("notes stay within the limit however long the evidence is", () => {
		const payload = buildMicrosoftSubmissionPayload({ ...input, description: `${input.description} ${"Credential harvesting form with a password field. ".repeat(200)}`, hostingLine: "H".repeat(900) })!;
		expect(payload.report.notes.length).toBeLessThanOrEqual(MICROSOFT_PROVIDER.notesMaximumLength);
		expect(payload.report.notes).toContain("Case details and screenshots:");
	});

	test("a bad reference, host or empty description yields no draft", () => {
		expect(buildMicrosoftSubmissionPayload({ ...input, reference: "PS-1-R1" })).toBeUndefined();
		expect(buildMicrosoftSubmissionPayload({ ...input, target: "not a host" })).toBeUndefined();
		expect(buildMicrosoftSubmissionPayload({ ...input, description: "  " })).toBeUndefined();
	});
});

describe("storedMicrosoftSubmissionPayload", () => {
	const stored = () => JSON.parse(JSON.stringify(buildMicrosoftSubmissionPayload(input)!));

	test("round-trips exactly what the adapter wrote", () => {
		expect(storedMicrosoftSubmissionPayload(stored())).toEqual(buildMicrosoftSubmissionPayload(input));
	});

	test("rejects every deviation", () => {
		const mutations: Array<(p: any) => void> = [
			(p) => { p.adapter = "aws_report_v1"; },
			(p) => { p.providerNarrativeVersion = 2; },
			(p) => { p.definition.version = "old"; },
			(p) => { p.definition.contentHash = "0".repeat(64); },
			(p) => { p.target.normalizedTarget = 5; },
			(p) => { p.report.incidentType = "Spam"; },
			(p) => { p.report.reference = "PS-1-R1"; },
			(p) => { p.report.urls = []; },
			(p) => { p.report.urls = Array.from({ length: 11 }, (_, i) => `https://x.azurewebsites.net/${i}`); },
			(p) => { p.report.urls = ["https://x.azurewebsites.net/a b"]; },
			(p) => { p.report.urls = ["https://x.azurewebsites.net/a,b"]; },
			(p) => { p.report.notes = ""; },
			(p) => { p.report.notes = "x".repeat(MICROSOFT_PROVIDER.notesMaximumLength + 1); },
			(p) => { delete p.report; },
		];
		for (const [index, mutate] of mutations.entries()) {
			const payload = stored();
			mutate(payload);
			expect(storedMicrosoftSubmissionPayload(payload), `mutation ${index}`).toBeUndefined();
		}
		expect(storedMicrosoftSubmissionPayload(null)).toBeUndefined();
		expect(storedMicrosoftSubmissionPayload("x")).toBeUndefined();
	});
});

describe("request", () => {
	test("observation time is the filing time in UTC", () => {
		expect(microsoftObservationTime(new Date("2026-11-20T11:02:41.500Z"))).toEqual({ date: "2026-11-20", time: "11:02", timeZone: "+0000" });
		expect(microsoftObservationTime(new Date("2026-12-31T23:59:59.999Z"))).toEqual({ date: "2026-12-31", time: "23:59", timeZone: "+0000" });
		expect(microsoftObservationTime(new Date("2027-01-01T00:00:00.000Z"))).toEqual({ date: "2027-01-01", time: "00:00", timeZone: "+0000" });
	});

	test("the body carries the portal's fields and the OpenAPI's only", () => {
		const payload = buildMicrosoftSubmissionPayload(input)!;
		const body = microsoftRequestBody(payload, new Date("2026-11-20T11:02:41Z"));
		expect(body).toEqual({
			threatType: "URL",
			source: "CertPortalV2",
			incidentType: "Phishing",
			reporterName: "Phishing Support",
			reporterEmail: "support@phishing.support",
			reporterOrg: "Phishing Support",
			phoneNumber: "",
			urlList: payload.report.urls.map((sourceUrl) => ({ sourceUrl })),
			reportNotes: payload.report.notes,
			date: "2026-11-20",
			time: "11:02",
			timeZone: "+0000",
			anonymizeReport: false,
		});
		expect((body as { urlList: unknown[] }).urlList.length).toBeLessThanOrEqual(10);
	});
});
