import { describe, expect, test } from "bun:test";

import { sha256Hex } from "../../security";
import type { AbuseArtifact } from "../../schema";
import { reportReferencesIn } from "../report_reference";
import { NAME_COM_PROVIDER as PROVIDER } from "./definition";
import {
	buildNameComSubmissionPayload,
	nameComReportUrls,
	selectNameComEvidenceArtifact,
	storedNameComSubmissionPayload,
	type NameComReportInput,
} from "./payload";

const REFERENCE = "PS-8fc84cc01019-R7";
const description = "The page asks visitors for a password, sign-in details, a verification code, or identity details.";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const artifact = (id: bigint, bytes = PNG, mimeType = "image/png") => ({ id, reportId: 1n, name: "shot.png", kind: "user_evidence_original", mimeType, sha256: sha256Hex(bytes), size: bytes.byteLength, blob: bytes, metadata: {}, createdAt: new Date() }) as unknown as AbuseArtifact;

function input(overrides: Partial<NameComReportInput> = {}): NameComReportInput {
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
	test("is pinned by a hash that covers the form's contract", () => {
		expect(PROVIDER.key).toBe("name_com");
		expect(PROVIDER.contentHash).toMatch(/^[a-f0-9]{64}$/);
		expect(PROVIDER.exactMailboxes).toEqual(["abuse@name.com"]);
		expect(PROVIDER.registrarIds).toEqual([625]);
		expect(PROVIDER.reporter).toEqual({ firstName: "Phishing", lastName: "Support", email: "support@phishing.support" });
		expect(PROVIDER.submitUrl).toBe("https://www.name.com/ajax/zendeskticket/create/");
	});
});

describe("complaint", () => {
	test("leads with the reference, lists the domain's URLs, then narrative, hosting and case page", () => {
		const payload = buildNameComSubmissionPayload(input())!;
		const complaint = payload.report.additional;
		expect(complaint.startsWith(`Reference: ${REFERENCE}\n\nReported URLs:\n- https://login-example-phish.com/signin\n\n`)).toBeTrue();
		expect(complaint).not.toContain("other.example");
		expect(complaint).toContain("A suspected phishing domain report is being submitted to Name.com for login-example-phish.com.");
		expect(complaint).toContain("Impersonated brand: https://www.examplebank.com/");
		expect(complaint).toContain("Hosting IP address: 203.0.113.7");
		expect(complaint.endsWith("Case details and screenshots: https://phishing.support/submissions/377486973465530391")).toBeTrue();
		expect(complaint.length).toBeLessThanOrEqual(2_000);
		expect(reportReferencesIn(complaint)).toEqual([REFERENCE]);
		expect(payload).toMatchObject({ adapter: "name_com_report_v1", target: { domain: "login-example-phish.com" }, report: { trackingId: REFERENCE }, evidence: null });
	});

	test("never exceeds 2000 characters, whatever the parts are", () => {
		const longPath = "a".repeat(450);
		const urls = Array.from({ length: 12 }, (_, index) => `https://login-example-phish.com/${longPath}${index}`);
		const payload = buildNameComSubmissionPayload(input({ observedUrls: urls, hostingLine: "H".repeat(3_000), description: `${description} ${"More evidence. ".repeat(400)}` }))!;
		expect(payload.report.additional.length).toBeLessThanOrEqual(2_000);
		expect(payload.report.additional).toContain("Case details and screenshots:");
		const listed = payload.report.additional.split("\n").filter((line) => line.startsWith("- https://"));
		expect(listed.length).toBe(1);
		expect(payload.report.additional).toContain("Please investigate");
	});

	test("URLs: the first that fit, deduplicated; the domain's root when none is observed", () => {
		expect(nameComReportUrls("a.com", ["https://a.com/x", "https://a.com/x", "https://b.com/", "not a url"])).toEqual(["https://a.com/x"]);
		expect(nameComReportUrls("a.com", [])).toEqual(["https://a.com/"]);
		expect(nameComReportUrls("a.com", Array.from({ length: 30 }, (_, index) => `https://a.com/${index}`))).toHaveLength(10);
		expect(nameComReportUrls("a.com", ["https://a.com/has space", `https://a.com/${"x".repeat(600)}`])).toEqual(["https://a.com/has%20space"]);
	});

	test("a malware report keeps its own wording", () => {
		const payload = buildNameComSubmissionPayload(input({ allegationCategory: "malware", legalBrandUrl: null, description: "The page serves a payload: sha256 abc, detected as a stealer." }))!;
		expect(payload.report.additional).toContain("A suspected malware distribution domain report");
		expect(payload.report.additional).not.toContain("Impersonated brand");
	});

	test("nothing is drafted for a non-domain target, a bad reference, or an empty description", () => {
		expect(buildNameComSubmissionPayload(input({ target: "203.0.113.7" }))).toBeUndefined();
		expect(buildNameComSubmissionPayload(input({ target: "not a host" }))).toBeUndefined();
		expect(buildNameComSubmissionPayload(input({ trackingId: "PS-1" }))).toBeUndefined();
		expect(buildNameComSubmissionPayload(input({ description: "" }))).toBeUndefined();
	});
});

describe("screenshot", () => {
	test("the first intact png/jpeg within 10 MB is selected; others are skipped", () => {
		const oversized = Buffer.concat([PNG, Buffer.alloc(10_000_001)]);
		expect(selectNameComEvidenceArtifact([artifact(1n, oversized), artifact(2n, Buffer.from("nope")), artifact(3n, PNG, "application/pdf"), artifact(4n)])?.artifactId).toBe("4");
		expect(selectNameComEvidenceArtifact([])).toBeUndefined();
	});
});

describe("stored payload", () => {
	const evidence = selectNameComEvidenceArtifact([artifact(9n)])!;
	const stored = () => JSON.parse(JSON.stringify(buildNameComSubmissionPayload(input({ evidence }))!)) as Record<string, any>;

	test("round-trips exactly, with or without a screenshot", () => {
		const withShot = stored();
		expect(storedNameComSubmissionPayload(withShot)).toEqual(withShot as never);
		expect(withShot.evidence.filename).toMatch(/^name_com_report_9_[a-f0-9]{12}\.png$/);
		const without = JSON.parse(JSON.stringify(buildNameComSubmissionPayload(input())!));
		expect(storedNameComSubmissionPayload(without)).toEqual(without);
	});

	test("anything else is refused", () => {
		const mutations: Array<[string, (payload: Record<string, any>) => void]> = [
			["adapter", (payload) => { payload.adapter = "other"; }],
			["narrative version", (payload) => { payload.providerNarrativeVersion = 2; }],
			["definition version", (payload) => { payload.definition.version = "old"; }],
			["definition hash", (payload) => { payload.definition.contentHash = "0".repeat(64); }],
			["domain not normalized", (payload) => { payload.target.domain = "Login-Example-Phish.com"; }],
			["ip domain", (payload) => { payload.target.domain = "203.0.113.7"; }],
			["tracking id", (payload) => { payload.report.trackingId = "PS-xyz-R1"; }],
			["complaint not led by the reference", (payload) => { payload.report.additional = `Reference: PS-8fc84cc01019-R8\n\n${payload.report.additional}`; }],
			["complaint empty", (payload) => { payload.report.additional = ""; }],
			["complaint too long", (payload) => { payload.report.additional = `Reference: ${REFERENCE}\n${"x".repeat(2_000)}`; }],
			["evidence missing", (payload) => { delete payload.evidence; }],
			["evidence tampered", (payload) => { payload.evidence.filename = "other.png"; }],
			["evidence type", (payload) => { payload.evidence.mimeType = "application/pdf"; }],
		];
		for (const [name, mutate] of mutations) {
			const payload = stored();
			mutate(payload);
			expect(storedNameComSubmissionPayload(payload), name).toBeUndefined();
		}
		expect(storedNameComSubmissionPayload(null)).toBeUndefined();
		expect(storedNameComSubmissionPayload("x")).toBeUndefined();
	});
});
