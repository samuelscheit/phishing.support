import { describe, expect, test } from "bun:test";

import { sha256Hex } from "../../security";
import type { AbuseArtifact } from "../../schema";
import { reportReferencesIn } from "../report_reference";
import { PUBLIC_DOMAIN_REGISTRY_PROVIDER as PROVIDER } from "./definition";
import {
	buildPublicDomainRegistrySubmissionPayload,
	publicDomainRegistryReportUrls,
	selectPublicDomainRegistryEvidenceArtifact,
	storedPublicDomainRegistrySubmissionPayload,
	type PublicDomainRegistryReportInput,
} from "./payload";

const REFERENCE = "PS-8fc84cc01019-R7";
const description = "The page asks visitors for a password, sign-in details, a verification code, or identity details.";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const artifact = (id: bigint, bytes = PNG, mimeType = "image/png") => ({ id, reportId: 1n, name: "shot.png", kind: "user_evidence_original", mimeType, sha256: sha256Hex(bytes), size: bytes.byteLength, blob: bytes, metadata: {}, createdAt: new Date() }) as unknown as AbuseArtifact;

function input(overrides: Partial<PublicDomainRegistryReportInput> = {}): PublicDomainRegistryReportInput {
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
		expect(PROVIDER.key).toBe("publicdomainregistry");
		expect(PROVIDER.contentHash).toMatch(/^[a-f0-9]{64}$/);
		expect(PROVIDER.exactMailboxes).toEqual(["abuse-contact@publicdomainregistry.com", "abuse@publicdomainregistry.com"]);
		expect(PROVIDER.feedbackUrl).toContain(`/contact-forms/${PROVIDER.formId}/feedback`);
	});
});

describe("complaint", () => {
	test("leads with the reference, lists the domain's URLs, then narrative, hosting and case page", () => {
		const payload = buildPublicDomainRegistrySubmissionPayload(input())!;
		const complaint = payload.report.complaint;
		expect(complaint.startsWith(`Reference: ${REFERENCE}\n\nReported URLs:\n- https://login-example-phish.com/signin\n\n`)).toBeTrue();
		expect(complaint).not.toContain("other.example");
		expect(complaint).toContain("A suspected phishing domain report is being submitted to PublicDomainRegistry for login-example-phish.com.");
		expect(complaint).toContain("Impersonated brand: https://www.examplebank.com/");
		expect(complaint).toContain("Hosting IP address: 203.0.113.7");
		expect(complaint.endsWith("Case details and screenshots: https://phishing.support/submissions/377486973465530391")).toBeTrue();
		expect(complaint.length).toBeLessThanOrEqual(2_000);
		expect(reportReferencesIn(complaint)).toEqual([REFERENCE]);
		expect(payload).toMatchObject({ adapter: "publicdomainregistry_report_v1", target: { domain: "login-example-phish.com" }, report: { trackingId: REFERENCE }, evidence: null });
	});

	test("never exceeds 2000 characters, whatever the parts are", () => {
		const longPath = "a".repeat(450);
		const urls = Array.from({ length: 12 }, (_, index) => `https://login-example-phish.com/${longPath}${index}`);
		const payload = buildPublicDomainRegistrySubmissionPayload(input({ observedUrls: urls, hostingLine: "H".repeat(3_000), description: `${description} ${"More evidence. ".repeat(400)}` }))!;
		expect(payload.report.complaint.length).toBeLessThanOrEqual(2_000);
		expect(payload.report.complaint).toContain("Case details and screenshots:");
		const listed = payload.report.complaint.split("\n").filter((line) => line.startsWith("- https://"));
		expect(listed.length).toBe(1);
		expect(payload.report.complaint).toContain("Please investigate");
	});

	test("URLs: the first that fit, deduplicated; the domain's root when none is observed", () => {
		expect(publicDomainRegistryReportUrls("a.com", ["https://a.com/x", "https://a.com/x", "https://b.com/", "not a url"])).toEqual(["https://a.com/x"]);
		expect(publicDomainRegistryReportUrls("a.com", [])).toEqual(["https://a.com/"]);
		expect(publicDomainRegistryReportUrls("a.com", Array.from({ length: 30 }, (_, index) => `https://a.com/${index}`))).toHaveLength(10);
		expect(publicDomainRegistryReportUrls("a.com", ["https://a.com/has space", `https://a.com/${"x".repeat(600)}`])).toEqual(["https://a.com/has%20space"]);
	});

	test("a malware report keeps its own wording", () => {
		const payload = buildPublicDomainRegistrySubmissionPayload(input({ allegationCategory: "malware", legalBrandUrl: null, description: "The page serves a payload: sha256 abc, detected as a stealer." }))!;
		expect(payload.report.complaint).toContain("A suspected malware distribution domain report");
		expect(payload.report.complaint).not.toContain("Impersonated brand");
	});

	test("nothing is drafted for a non-domain target, a bad reference, or an empty description", () => {
		expect(buildPublicDomainRegistrySubmissionPayload(input({ target: "203.0.113.7" }))).toBeUndefined();
		expect(buildPublicDomainRegistrySubmissionPayload(input({ target: "not a host" }))).toBeUndefined();
		expect(buildPublicDomainRegistrySubmissionPayload(input({ trackingId: "PS-1" }))).toBeUndefined();
		expect(buildPublicDomainRegistrySubmissionPayload(input({ description: "" }))).toBeUndefined();
	});
});

describe("screenshot", () => {
	test("the first intact png/jpeg within 5 MB is selected; others are skipped", () => {
		const oversized = Buffer.concat([PNG, Buffer.alloc(5_000_001)]);
		expect(selectPublicDomainRegistryEvidenceArtifact([artifact(1n, oversized), artifact(2n, Buffer.from("nope")), artifact(3n, PNG, "application/pdf"), artifact(4n)])?.artifactId).toBe("4");
		expect(selectPublicDomainRegistryEvidenceArtifact([])).toBeUndefined();
	});
});

describe("stored payload", () => {
	const evidence = selectPublicDomainRegistryEvidenceArtifact([artifact(9n)])!;
	const stored = () => JSON.parse(JSON.stringify(buildPublicDomainRegistrySubmissionPayload(input({ evidence }))!)) as Record<string, any>;

	test("round-trips exactly, with or without a screenshot", () => {
		const withShot = stored();
		expect(storedPublicDomainRegistrySubmissionPayload(withShot)).toEqual(withShot as never);
		expect(withShot.evidence.filename).toMatch(/^publicdomainregistry_report_9_[a-f0-9]{12}\.png$/);
		const without = JSON.parse(JSON.stringify(buildPublicDomainRegistrySubmissionPayload(input())!));
		expect(storedPublicDomainRegistrySubmissionPayload(without)).toEqual(without);
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
			["complaint not led by the reference", (payload) => { payload.report.complaint = `Reference: PS-8fc84cc01019-R8\n\n${payload.report.complaint}`; }],
			["complaint empty", (payload) => { payload.report.complaint = ""; }],
			["complaint too long", (payload) => { payload.report.complaint = `Reference: ${REFERENCE}\n${"x".repeat(2_000)}`; }],
			["evidence missing", (payload) => { delete payload.evidence; }],
			["evidence tampered", (payload) => { payload.evidence.filename = "other.png"; }],
			["evidence type", (payload) => { payload.evidence.mimeType = "application/pdf"; }],
		];
		for (const [name, mutate] of mutations) {
			const payload = stored();
			mutate(payload);
			expect(storedPublicDomainRegistrySubmissionPayload(payload), name).toBeUndefined();
		}
		expect(storedPublicDomainRegistrySubmissionPayload(null)).toBeUndefined();
		expect(storedPublicDomainRegistrySubmissionPayload("x")).toBeUndefined();
	});
});
