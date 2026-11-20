import { describe, expect, test } from "bun:test";

import { providerDefinitionHasValidHash } from "../kit/pin";
import { selectProviderEvidenceImageArtifact } from "../evidence_image";
import { mailedCodeFrom } from "../mailed_code";
import { sha256Hex } from "../../security";
import type { AbuseArtifact } from "../../schema";
import { TUCOWS_PROVIDER } from "./definition";
import { buildTucowsSubmissionPayload, makeTucowsDescription, TUCOWS_EVIDENCE_CONTRACT, storedTucowsSubmissionPayload, tucowsBrand, tucowsReportUrls, type TucowsReportInput } from "./payload";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("tucows-screenshot")]);
const artifact = (overrides: Partial<AbuseArtifact> = {}) => ({
	id: 12n, reportId: 3n, name: "website.png", kind: "user_evidence_original", mimeType: "image/png",
	sha256: sha256Hex(PNG), size: PNG.byteLength, blob: PNG, metadata: {}, createdAt: new Date(), ...overrides,
}) as unknown as AbuseArtifact;
const selectTucowsEvidenceArtifact = (artifacts: Parameters<typeof selectProviderEvidenceImageArtifact>[0]) => selectProviderEvidenceImageArtifact(artifacts, TUCOWS_EVIDENCE_CONTRACT);
const evidence = selectTucowsEvidenceArtifact([artifact()])!;

const REFERENCE = "PS-8fc84cc01019-R42";
const input: TucowsReportInput = {
	target: "login-example-phish.com",
	observedUrls: ["https://login-example-phish.com/signin", "https://other.example/x"],
	description: "Impersonated brand: Example Bank\nThe page asks visitors for a password and sign-in details.",
	allegationCategory: "phishing",
	legalBrandUrl: "https://www.examplebank.com/",
	trackingId: REFERENCE,
	caseUrl: "https://phishing.support/submissions/42",
	hostingLine: "Hosting IP address: 203.0.113.9 (login-example-phish.com resolved to 203.0.113.9 on 2026-11-20)",
	evidence,
};

describe("definition", () => {
	test("is pinned by its own hash and files as the service identity", () => {
		expect(providerDefinitionHasValidHash(TUCOWS_PROVIDER)).toBeTrue();
		expect(TUCOWS_PROVIDER.reporter).toEqual({ name: "Phishing Support", email: "support@phishing.support", organization: "Phishing Support", role: "it_security" });
		expect(TUCOWS_PROVIDER.exactMailboxes).toEqual(["domainabuse@tucows.com", "abuse@enom.com"]);
		expect(TUCOWS_PROVIDER.captcha).toMatchObject({ type: 12, siteKey: "0x4AAAAAADhWTmUwriZtddpv", pageUrl: "https://bullwark.tucows.com/report" });
	});

	test("reads the code from Tucows' mail only, not a colour or a year", () => {
		const html = `<html><style>a{color:#364971;margin:100000px}</style><body><p>Use the code below to verify your identity on the Tucows Domains abuse report form.</p><p style="font-size:24px">364971</p><p>Expires in 15 minutes</p><p>&copy; 2026 Tucows Inc.</p></body></html>`;
		const mail = { from: "noreply@bullwark.tucows.com", subject: "Your verification code", body: html };
		expect(mailedCodeFrom(TUCOWS_PROVIDER.codeMail, mail)).toBe("364971");
		expect(mailedCodeFrom(TUCOWS_PROVIDER.codeMail, { ...mail, body: "Use the code below.\n\n364971\n\nExpires in 15 minutes" })).toBe("364971");
		expect(mailedCodeFrom(TUCOWS_PROVIDER.codeMail, { ...mail, from: "noreply@tucows.evil.example" })).toBeUndefined();
		expect(mailedCodeFrom(TUCOWS_PROVIDER.codeMail, { ...mail, from: "noreply@nottucows.com" })).toBeUndefined();
		expect(mailedCodeFrom(TUCOWS_PROVIDER.codeMail, { ...mail, subject: "Your invoice" })).toBeUndefined();
		expect(mailedCodeFrom(TUCOWS_PROVIDER.codeMail, { ...mail, body: "code 1234567 and 12345" })).toBeUndefined();
	});
});

describe("evidence", () => {
	test("takes an intact PNG or JPEG original; others are no evidence", () => {
		expect(evidence).toMatchObject({ artifactId: "12", mimeType: "image/png", size: PNG.byteLength });
		expect(evidence.filename).toStartWith("tucows_report_12_");
		const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("x")]);
		expect(selectTucowsEvidenceArtifact([artifact({ id: 5n, mimeType: "image/jpeg", blob: jpeg, size: jpeg.byteLength, sha256: sha256Hex(jpeg) })])?.mimeType).toBe("image/jpeg");
		expect(selectTucowsEvidenceArtifact([artifact({ mimeType: "image/gif" })])).toBeUndefined();
		expect(selectTucowsEvidenceArtifact([artifact({ sha256: "0".repeat(64) })])).toBeUndefined();
		expect(selectTucowsEvidenceArtifact([artifact({ kind: "screenshot" })])).toBeUndefined();
		const big = Buffer.concat([PNG, Buffer.alloc(TUCOWS_PROVIDER.evidence.maximumBytes)]);
		expect(selectTucowsEvidenceArtifact([artifact({ blob: big, size: big.byteLength, sha256: sha256Hex(big) })])).toBeUndefined();
	});
});

describe("url and brand", () => {
	test("the offending URL is an observed URL of the target, else its root", () => {
		expect(tucowsReportUrls("login-example-phish.com", input.observedUrls)).toEqual(["https://login-example-phish.com/signin"]);
		expect(tucowsReportUrls("login-example-phish.com", ["javascript:alert(1)", "https://other.example/"])).toEqual(["https://login-example-phish.com/"]);
		expect(tucowsReportUrls("login-example-phish.com", [])).toEqual(["https://login-example-phish.com/"]);
	});

	test("the brand is the analysis' label with the legal brand's domain, or the domain's own name", () => {
		expect(tucowsBrand(input.description, "https://www.examplebank.com/")).toEqual({ name: "Example Bank", domain: "examplebank.com" });
		expect(tucowsBrand("Login page.", "https://www.examplebank.co.uk/")).toEqual({ name: "Co", domain: "examplebank.co.uk" });
		expect(tucowsBrand("Login page.", "https://login.paypal.com/")).toEqual({ name: "Paypal", domain: "login.paypal.com" });
		expect(tucowsBrand(input.description, null)).toBeUndefined();
		expect(tucowsBrand(input.description, "not a url")).toBeUndefined();
	});
});

describe("buildTucowsSubmissionPayload", () => {
	test("drafts the form values; the message leads with our reference and holds the case page and hosting line", () => {
		const payload = buildTucowsSubmissionPayload(input)!;
		expect(payload).toMatchObject({
			adapter: "tucows_report_v1",
			target: { normalizedTarget: "login-example-phish.com" },
			report: { reference: REFERENCE, offendingDomain: "login-example-phish.com", brandName: "Example Bank", brandDomain: "examplebank.com", url: "https://login-example-phish.com/signin" },
			evidence,
		});
		const message = payload.report.description;
		expect(message.startsWith(`Reference: ${REFERENCE}\n\n`)).toBeTrue();
		expect(message).toContain("phishing");
		expect(message).toContain(input.hostingLine!);
		expect(message).toEndWith("Case details and screenshots: https://phishing.support/submissions/42");
		expect(message.length).toBeLessThanOrEqual(TUCOWS_PROVIDER.maximumDescriptionLength);
	});

	test("leaves out the hosting line and the case page when there are none", () => {
		const { hostingLine, caseUrl, ...bare } = input;
		const message = buildTucowsSubmissionPayload(bare)!.report.description;
		expect(message).not.toContain("Hosting IP");
		expect(message).not.toContain("Case details");
	});

	test("cannot be filed here: malware, no brand domain, bad reference, bad target, bad evidence", () => {
		expect(buildTucowsSubmissionPayload({ ...input, allegationCategory: "malware" })).toBeUndefined();
		expect(buildTucowsSubmissionPayload({ ...input, legalBrandUrl: null })).toBeUndefined();
		expect(buildTucowsSubmissionPayload({ ...input, trackingId: "R1" })).toBeUndefined();
		expect(buildTucowsSubmissionPayload({ ...input, target: "not a host" })).toBeUndefined();
		expect(buildTucowsSubmissionPayload({ ...input, evidence: { ...evidence, filename: "x.png" } })).toBeUndefined();
		expect(buildTucowsSubmissionPayload({ ...input, description: "   " })).toBeUndefined();
	});

	test("a message over the form's room is not sent", () => {
		expect(makeTucowsDescription({ ...input, hostingLine: undefined, caseUrl: `https://phishing.support/${"a".repeat(TUCOWS_PROVIDER.maximumDescriptionLength)}` }, ["https://login-example-phish.com/"])).toBeUndefined();
	});
});

describe("storedTucowsSubmissionPayload", () => {
	const payload = buildTucowsSubmissionPayload(input)!;

	test("round-trips the exact shape", () => {
		expect(storedTucowsSubmissionPayload(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
	});

	test("refuses anything else", () => {
		const bad = (change: (copy: Record<string, any>) => void) => {
			const copy = JSON.parse(JSON.stringify(payload));
			change(copy);
			return storedTucowsSubmissionPayload(copy);
		};
		expect(storedTucowsSubmissionPayload(null)).toBeUndefined();
		expect(storedTucowsSubmissionPayload({})).toBeUndefined();
		expect(bad((p) => { p.adapter = "aws_report_v1"; })).toBeUndefined();
		expect(bad((p) => { p.definition.version = "old"; })).toBeUndefined();
		expect(bad((p) => { p.definition.contentHash = "0"; })).toBeUndefined();
		expect(bad((p) => { p.target.normalizedTarget = 1; })).toBeUndefined();
		expect(bad((p) => { p.report.reference = "x"; })).toBeUndefined();
		expect(bad((p) => { p.report.url = "ftp://x.example/"; })).toBeUndefined();
		expect(bad((p) => { p.report.url = "https://x.example/a b"; })).toBeUndefined();
		expect(bad((p) => { p.report.brandName = ""; })).toBeUndefined();
		expect(bad((p) => { p.report.brandDomain = 3; })).toBeUndefined();
		expect(bad((p) => { p.report.offendingDomain = ""; })).toBeUndefined();
		expect(bad((p) => { p.report.description = "x".repeat(TUCOWS_PROVIDER.maximumDescriptionLength + 1); })).toBeUndefined();
		expect(bad((p) => { delete p.evidence; })).toBeUndefined();
		expect(bad((p) => { p.evidence.filename = "evil.png"; })).toBeUndefined();
		expect(bad((p) => { p.evidence.mimeType = "image/gif"; })).toBeUndefined();
	});
});
