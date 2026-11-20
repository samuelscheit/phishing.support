import { describe, expect, test } from "bun:test";

import { selectProviderEvidenceImageArtifact } from "../evidence_image";
import { DESCRIPTION as description, PNG, pngArtifact as artifact } from "../kit/testing";
import { reportReferencesIn } from "../report_reference";
import { DYNADOT_PROVIDER as PROVIDER } from "./definition";
import {
	buildDynadotSubmissionPayload,
	dynadotOfficialWebsite,
	dynadotReportUrls,
	DYNADOT_EVIDENCE_CONTRACT,
	storedDynadotSubmissionPayload,
	type DynadotReportInput,
} from "./payload";

const REFERENCE = "PS-8fc84cc01019-R7";
const select = (artifacts: Parameters<typeof selectProviderEvidenceImageArtifact>[0]) => selectProviderEvidenceImageArtifact(artifacts, DYNADOT_EVIDENCE_CONTRACT);

function input(overrides: Partial<DynadotReportInput> = {}): DynadotReportInput {
	return {
		target: "login-example-phish.com",
		observedUrls: ["https://login-example-phish.com/signin", "https://login-example-phish.com/two", "https://other.example/x"],
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
	test("is pinned by a hash that covers the form's contract, for IANA 472 and the abuse mailbox", () => {
		expect(PROVIDER).toMatchObject({ key: "dynadot", registrarIds: [472], exactMailboxes: ["abuse@dynadot.com"], abuseType: "2" });
		expect(PROVIDER.contentHash).toMatch(/^[a-f0-9]{64}$/);
		expect(PROVIDER.submitUrl).toContain("command=submit_abuse");
	});
});

describe("comments", () => {
	test("lead with the reference, list the domain's URLs, then narrative, hosting and case page", () => {
		const payload = buildDynadotSubmissionPayload(input())!;
		const { comments } = payload.report;
		expect(comments.startsWith(`Reference: ${REFERENCE}\n\nReported URLs:\n- https://login-example-phish.com/signin\n- https://login-example-phish.com/two\n\n`)).toBeTrue();
		expect(comments).not.toContain("other.example");
		expect(comments).toContain("A suspected phishing domain report is being submitted to Dynadot for login-example-phish.com.");
		expect(comments).toContain("Hosting IP address: 203.0.113.7");
		expect(comments.endsWith("Case details and screenshots: https://phishing.support/submissions/377486973465530391")).toBeTrue();
		expect(reportReferencesIn(comments)).toEqual([REFERENCE]);
		expect(payload).toMatchObject({
			adapter: "dynadot_report_v1",
			target: { domain: "login-example-phish.com" },
			report: { trackingId: REFERENCE, domainPath: "https://login-example-phish.com/signin", officialWebsite: "https://www.examplebank.com/" },
			evidence: null,
		});
	});

	test("never exceed the limit, whatever the parts are", () => {
		const urls = Array.from({ length: 12 }, (_, index) => `https://login-example-phish.com/${"a".repeat(240)}${index}`);
		const { report } = buildDynadotSubmissionPayload(input({ observedUrls: urls, hostingLine: "H".repeat(5_000), description: `${description} ${"More evidence. ".repeat(600)}` }))!;
		expect(report.comments.length).toBeLessThanOrEqual(PROVIDER.commentsMaximumLength);
		expect(report.comments).toContain("Case details and screenshots:");
		expect(report.domainPath.length).toBeLessThanOrEqual(PROVIDER.inputMaximumLength);
	});

	test("URLs: those that fit the 255-character input, deduplicated; the domain's root when none is observed", () => {
		expect(dynadotReportUrls("a.com", ["https://a.com/x", "https://a.com/x", "https://b.com/", "nope"])).toEqual(["https://a.com/x"]);
		expect(dynadotReportUrls("a.com", [])).toEqual(["https://a.com/"]);
		expect(dynadotReportUrls("a.com", [`https://a.com/${"x".repeat(300)}`, "https://a.com/short"])).toEqual(["https://a.com/short"]);
		expect(dynadotReportUrls("a.com", Array.from({ length: 30 }, (_, index) => `https://a.com/${index}`))).toHaveLength(10);
	});

	test("Official Website is the brand's site, or N/A", () => {
		expect(dynadotOfficialWebsite("https://www.examplebank.com/")).toBe("https://www.examplebank.com/");
		expect(dynadotOfficialWebsite(null)).toBe("N/A");
		expect(dynadotOfficialWebsite("not a url")).toBe("N/A");
		expect(buildDynadotSubmissionPayload(input({ legalBrandUrl: null }))!.report.officialWebsite).toBe("N/A");
	});

	test("a malware report keeps its own wording", () => {
		const { report } = buildDynadotSubmissionPayload(input({ allegationCategory: "malware", legalBrandUrl: null, description: "The page serves a payload: sha256 abc, detected as a stealer." }))!;
		expect(report.comments).toContain("A suspected malware distribution domain report");
		expect(report.comments).not.toContain("Impersonated brand");
	});

	test("nothing is drafted for a non-domain target, a bad reference, or an empty description", () => {
		expect(buildDynadotSubmissionPayload(input({ target: "203.0.113.7" }))).toBeUndefined();
		expect(buildDynadotSubmissionPayload(input({ target: "not a host" }))).toBeUndefined();
		expect(buildDynadotSubmissionPayload(input({ trackingId: "PS-1" }))).toBeUndefined();
		expect(buildDynadotSubmissionPayload(input({ description: "" }))).toBeUndefined();
	});
});

describe("screenshot", () => {
	test("the first intact png/jpeg within 5 MB is selected; others are skipped", () => {
		const oversized = Buffer.concat([PNG, Buffer.alloc(5_000_001)]);
		expect(select([artifact(1n, oversized), artifact(2n, Buffer.from("nope")), artifact(3n, PNG, "application/pdf"), artifact(4n)])?.artifactId).toBe("4");
		expect(select([])).toBeUndefined();
	});
});

describe("stored payload", () => {
	const evidence = select([artifact(9n)])!;
	const stored = () => JSON.parse(JSON.stringify(buildDynadotSubmissionPayload(input({ evidence }))!)) as Record<string, any>;

	test("round-trips exactly, with or without a screenshot", () => {
		const withShot = stored();
		expect(storedDynadotSubmissionPayload(withShot)).toEqual(withShot as never);
		expect(withShot.evidence.filename).toMatch(/^dynadot_report_9_[a-f0-9]{12}\.png$/);
		const without = JSON.parse(JSON.stringify(buildDynadotSubmissionPayload(input({ legalBrandUrl: null }))!));
		expect(storedDynadotSubmissionPayload(without)).toEqual(without);
	});

	test("anything else is refused", () => {
		const mutations: Array<[string, (payload: Record<string, any>) => void]> = [
			["adapter", (payload) => { payload.adapter = "other"; }],
			["definition version", (payload) => { payload.definition.version = "old"; }],
			["definition hash", (payload) => { payload.definition.contentHash = "0".repeat(64); }],
			["domain not normalized", (payload) => { payload.target.domain = "Login-Example-Phish.com"; }],
			["ip domain", (payload) => { payload.target.domain = "203.0.113.7"; }],
			["tracking id", (payload) => { payload.report.trackingId = "PS-xyz-R1"; }],
			["comments not led by the reference", (payload) => { payload.report.comments = `Reference: PS-8fc84cc01019-R8\n\n${payload.report.comments}`; }],
			["comments empty", (payload) => { payload.report.comments = ""; }],
			["comments too long", (payload) => { payload.report.comments = `Reference: ${REFERENCE}\n${"x".repeat(3_000)}`; }],
			["domain path not a url", (payload) => { payload.report.domainPath = "login page"; }],
			["domain path too long", (payload) => { payload.report.domainPath = `https://login-example-phish.com/${"x".repeat(260)}`; }],
			["official website free text", (payload) => { payload.report.officialWebsite = "the bank"; }],
			["official website empty", (payload) => { payload.report.officialWebsite = ""; }],
			["evidence missing", (payload) => { delete payload.evidence; }],
			["evidence tampered", (payload) => { payload.evidence.filename = "other.png"; }],
			["evidence type", (payload) => { payload.evidence.mimeType = "application/pdf"; }],
		];
		for (const [name, mutate] of mutations) {
			const payload = stored();
			mutate(payload);
			expect(storedDynadotSubmissionPayload(payload), name).toBeUndefined();
		}
		expect(storedDynadotSubmissionPayload(null)).toBeUndefined();
		expect(storedDynadotSubmissionPayload("x")).toBeUndefined();
	});
});
