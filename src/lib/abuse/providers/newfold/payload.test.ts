import { describe, expect, test } from "bun:test";

import { selectProviderEvidenceImageArtifact } from "../kit/evidence";
import { DESCRIPTION as description, PNG, pngArtifact as artifact } from "../kit/testing";
import { reportReferencesIn } from "../kit/report_reference";
import { NEWFOLD_PROVIDER as PROVIDER } from "./definition";
import {
	buildNewfoldSubmissionPayload,
	newfoldBrandForRoute,
	newfoldReportUrls,
	NEWFOLD_EVIDENCE_CONTRACT,
	storedNewfoldSubmissionPayload,
	type NewfoldReportInput,
} from "./payload";

const REFERENCE = "PS-8fc84cc01019-R7";
const select = (artifacts: Parameters<typeof selectProviderEvidenceImageArtifact>[0]) => selectProviderEvidenceImageArtifact(artifacts, NEWFOLD_EVIDENCE_CONTRACT);

function input(overrides: Partial<NewfoldReportInput> = {}): NewfoldReportInput {
	return {
		target: "login-example-phish.com",
		observedUrls: ["https://login-example-phish.com/signin", "https://other.example/x"],
		description,
		allegationCategory: "phishing",
		legalBrandUrl: "https://www.examplebank.com/",
		trackingId: REFERENCE,
		brand: "800-bluehost",
		caseUrl: "https://phishing.support/submissions/377486973465530391",
		hostingLine: "Hosting IP address: 203.0.113.7 (login-example-phish.com resolved to 203.0.113.7).",
		...overrides,
	};
}

describe("definition", () => {
	test("is pinned by a hash and carries the form's constants", () => {
		expect(PROVIDER.contentHash).toMatch(/^[a-f0-9]{64}$/);
		expect(PROVIDER.inquiryType).toBe("ABUSE-FORM-0008");
		expect(PROVIDER.reporter).toEqual({ firstName: "Phishing", lastName: "Support", email: "support@phishing.support" });
		expect(PROVIDER.registrarIds).toEqual([2, 9, 886]);
		expect(PROVIDER.exactMailboxes.every((mailbox) => mailbox === mailbox.toLowerCase())).toBeTrue();
		for (const brand of [...Object.values(PROVIDER.brandByMailbox), ...Object.values(PROVIDER.brandByRegistrarId), PROVIDER.defaultBrand]) expect(PROVIDER.brands).toContain(brand);
		expect(Object.keys(PROVIDER.brandByMailbox).every((mailbox) => (PROVIDER.exactMailboxes as readonly string[]).includes(mailbox))).toBeTrue();
	});
});

describe("brand", () => {
	test("registrar ID first, then the exact mailbox, else Other", () => {
		expect(newfoldBrandForRoute({ resolverProvenance: { registrarId: 2 } })).toBe("100-networksolutions.com");
		expect(newfoldBrandForRoute({ resolverProvenance: { registrarId: 9 } })).toBe("200-register.com");
		expect(newfoldBrandForRoute({ resolverProvenance: { registrarId: 886 } })).toBe("Domain.com");
		expect(newfoldBrandForRoute({ verifiedEmail: "abuse@bluehost.com", resolverProvenance: {} })).toBe("800-bluehost");
		expect(newfoldBrandForRoute({ verifiedEmail: "Abuse@Unifiedlayer.com", resolverProvenance: {} })).toBe("800-bluehost");
		expect(newfoldBrandForRoute({ verifiedEmail: "net-eng-team@newfold.com", resolverProvenance: null })).toBe("300-web.com");
		expect(newfoldBrandForRoute({ verifiedEmail: "iarpoc@newfold.com", resolverProvenance: {} })).toBe("100-other");
		expect(newfoldBrandForRoute({ verifiedEmail: null })).toBe("100-other");
		expect(newfoldBrandForRoute({ resolverProvenance: { registrarId: 1234 }, verifiedEmail: "abuse@bluehost.com" })).toBe("800-bluehost");
	});
});

describe("comments", () => {
	test("lead with the reference, list the domain's URLs, then narrative, hosting and case page", () => {
		const payload = buildNewfoldSubmissionPayload(input())!;
		const { comments } = payload.report;
		expect(comments.startsWith(`Reference: ${REFERENCE}\n\nReported URLs:\n- https://login-example-phish.com/signin\n\n`)).toBeTrue();
		expect(comments).not.toContain("other.example");
		expect(comments).toContain("A suspected phishing domain report is being submitted to Newfold Digital for login-example-phish.com.");
		expect(comments).toContain("Impersonated brand: https://www.examplebank.com/");
		expect(comments).toContain("Hosting IP address: 203.0.113.7");
		expect(comments.endsWith("Case details and screenshots: https://phishing.support/submissions/377486973465530391")).toBeTrue();
		expect(comments.length).toBeLessThanOrEqual(1_000);
		expect(reportReferencesIn(comments)).toEqual([REFERENCE]);
		expect(payload).toMatchObject({ adapter: "newfold_report_v1", target: { domain: "login-example-phish.com" }, report: { trackingId: REFERENCE, brand: "800-bluehost", url: "https://login-example-phish.com/signin" }, evidence: null });
	});

	test("never exceed 1000 characters, whatever the parts are", () => {
		const urls = Array.from({ length: 12 }, (_, index) => `https://login-example-phish.com/${"a".repeat(150)}${index}`);
		const payload = buildNewfoldSubmissionPayload(input({ observedUrls: urls, hostingLine: "H".repeat(3_000), description: `${description} ${"More evidence. ".repeat(400)}` }))!;
		expect(payload.report.comments.length).toBeLessThanOrEqual(1_000);
		expect(payload.report.comments).toContain("Case details and screenshots:");
		expect(payload.report.comments.split("\n").filter((line) => line.startsWith("- https://")).length).toBe(1);
		expect(payload.report.comments).toContain("Please investigate");
		expect(buildNewfoldSubmissionPayload(input({ caseUrl: `https://phishing.support/${"c".repeat(900)}` }))).toBeUndefined();
	});

	test("URLs: the first that fit, deduplicated, at most five; the root when none is observed", () => {
		expect(newfoldReportUrls("a.com", ["https://a.com/x", "https://a.com/x", "https://b.com/", "not a url"])).toEqual(["https://a.com/x"]);
		expect(newfoldReportUrls("a.com", [])).toEqual(["https://a.com/"]);
		expect(newfoldReportUrls("a.com", Array.from({ length: 30 }, (_, index) => `https://a.com/${index}`))).toHaveLength(5);
		expect(newfoldReportUrls("a.com", ["https://a.com/has space", `https://a.com/${"x".repeat(300)}`])).toEqual(["https://a.com/has%20space"]);
	});

	test("a malware report keeps its own wording", () => {
		const payload = buildNewfoldSubmissionPayload(input({ allegationCategory: "malware", legalBrandUrl: null, description: "The page serves a payload: sha256 abc, detected as a stealer." }))!;
		expect(payload.report.comments).toContain("A suspected malware distribution domain report");
		expect(payload.report.comments).not.toContain("Impersonated brand");
	});

	test("nothing is drafted for a non-domain target, a bad reference, an unknown brand or an empty description", () => {
		expect(buildNewfoldSubmissionPayload(input({ target: "203.0.113.7" }))).toBeUndefined();
		expect(buildNewfoldSubmissionPayload(input({ target: "not a host" }))).toBeUndefined();
		expect(buildNewfoldSubmissionPayload(input({ trackingId: "PS-1" }))).toBeUndefined();
		expect(buildNewfoldSubmissionPayload(input({ brand: "999-nope" }))).toBeUndefined();
		expect(buildNewfoldSubmissionPayload(input({ description: "" }))).toBeUndefined();
	});
});

describe("screenshot", () => {
	test("the first intact png/jpeg within 1 MiB is selected; others are skipped", () => {
		const oversized = Buffer.concat([PNG, Buffer.alloc(1_048_576)]);
		expect(select([artifact(1n, oversized), artifact(2n, Buffer.from("nope")), artifact(3n, PNG, "application/pdf"), artifact(4n)])?.artifactId).toBe("4");
		expect(select([])).toBeUndefined();
	});
});

describe("stored payload", () => {
	const evidence = select([artifact(9n)])!;
	const stored = () => JSON.parse(JSON.stringify(buildNewfoldSubmissionPayload(input({ evidence }))!)) as Record<string, any>;

	test("round-trips exactly, with or without a screenshot", () => {
		const withShot = stored();
		expect(storedNewfoldSubmissionPayload(withShot)).toEqual(withShot as never);
		expect(withShot.evidence.filename).toMatch(/^newfold_report_9_[a-f0-9]{12}\.png$/);
		const without = JSON.parse(JSON.stringify(buildNewfoldSubmissionPayload(input())!));
		expect(storedNewfoldSubmissionPayload(without)).toEqual(without);
	});

	test("anything else is refused", () => {
		const mutations: Array<[string, (payload: Record<string, any>) => void]> = [
			["domain not normalized", (payload) => { payload.target.domain = "Login-Example-Phish.com"; }],
			["ip domain", (payload) => { payload.target.domain = "203.0.113.7"; }],
			["tracking id", (payload) => { payload.report.trackingId = "PS-xyz-R1"; }],
			["brand unknown", (payload) => { payload.report.brand = "evil"; }],
			["brand missing", (payload) => { delete payload.report.brand; }],
			["url with space", (payload) => { payload.report.url = "https://a.com/a b"; }],
			["url not normalized", (payload) => { payload.report.url = "HTTP://A.com"; }],
			["comments not led by the reference", (payload) => { payload.report.comments = `Reference: PS-8fc84cc01019-R8\n\n${payload.report.comments}`; }],
			["comments empty", (payload) => { payload.report.comments = ""; }],
			["comments too long", (payload) => { payload.report.comments = `Reference: ${REFERENCE}\n${"x".repeat(1_000)}`; }],
			["evidence missing", (payload) => { delete payload.evidence; }],
			["evidence tampered", (payload) => { payload.evidence.filename = "other.png"; }],
			["evidence type", (payload) => { payload.evidence.mimeType = "application/pdf"; }],
		];
		for (const [name, mutate] of mutations) {
			const payload = stored();
			mutate(payload);
			expect(storedNewfoldSubmissionPayload(payload), name).toBeUndefined();
		}
		expect(storedNewfoldSubmissionPayload(null)).toBeUndefined();
		expect(storedNewfoldSubmissionPayload("x")).toBeUndefined();
	});
});
