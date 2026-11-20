import { describe, expect, test } from "bun:test";

import type { AbuseArtifact } from "../../schema";
import { sha256Hex } from "../../security";
import { providerDefinitionHasValidHash } from "../definition";
import { ALIBABA_CLOUD_PROVIDER } from "./definition";
import {
	alibabaCloudSubmitParams,
	alibabaReportObject,
	buildAlibabaCloudSubmissionPayload,
	makeAlibabaCloudReportReason,
	selectAlibabaCloudScreenshot,
	storedAlibabaCloudSubmissionPayload,
	type AlibabaCloudReportInput,
	type AlibabaCloudSubmissionPayload,
} from "./payload";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("alibaba")]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function artifact(id: bigint, bytes: Buffer = PNG, overrides: Partial<AbuseArtifact> = {}): AbuseArtifact {
	return { id, reportId: 9n, name: "website.png", kind: "user_evidence_original", mimeType: "image/png", sha256: sha256Hex(bytes), size: bytes.byteLength, blob: bytes, metadata: {}, createdAt: new Date(), ...overrides } as unknown as AbuseArtifact;
}

const screenshot = selectAlibabaCloudScreenshot([artifact(77n)])!;
const description = "The page asks visitors for a password, sign-in details, a verification code, or identity details.";
const target = "login-example-phish.com";
const input: AlibabaCloudReportInput & { screenshot: typeof screenshot } = { target, observedUrls: [`https://${target}/signin`], description, allegationCategory: "phishing", legalBrandUrl: "https://www.examplebank.com/login", screenshot };

function build(overrides: Partial<typeof input> = {}): AlibabaCloudSubmissionPayload {
	const payload = buildAlibabaCloudSubmissionPayload({ ...input, ...overrides });
	if (!payload) throw new Error("expected a payload");
	return payload;
}

describe("Alibaba Cloud definition", () => {
	test("is hash-pinned and owns exactly the three mailboxes", () => {
		expect(providerDefinitionHasValidHash(ALIBABA_CLOUD_PROVIDER)).toBeTrue();
		expect(ALIBABA_CLOUD_PROVIDER.exactMailboxes).toEqual(["domainabuse@service.aliyun.com", "infosec@service.aliyun.com", "abuse@alibaba-inc.com"]);
		expect(Object.isFrozen(ALIBABA_CLOUD_PROVIDER)).toBeTrue();
		expect(ALIBABA_CLOUD_PROVIDER.supplemental).toBeFalse();
	});

	test("a changed field changes the pinned hash", () => {
		expect(providerDefinitionHasValidHash({ ...ALIBABA_CLOUD_PROVIDER, version: "changed" } as typeof ALIBABA_CLOUD_PROVIDER)).toBeFalse();
	});
});

describe("screenshot selection", () => {
	test("takes the first intact PNG or JPEG original and names the file after artifact and hash", () => {
		expect(screenshot).toMatchObject({ artifactId: "77", mimeType: "image/png", size: PNG.byteLength, sha256: sha256Hex(PNG) });
		expect(screenshot.filename).toBe(`alibaba_cloud_report_77_${sha256Hex(PNG).slice(0, 12)}.png`);
		expect(selectAlibabaCloudScreenshot([artifact(1n, JPEG, { mimeType: "image/jpeg" })])?.filename).toEndWith(".jpg");
		expect(selectAlibabaCloudScreenshot([artifact(1n, PNG, { sha256: "0".repeat(64) }), artifact(2n)])?.artifactId).toBe("2");
	});

	test("refuses a GIF, a wrong signature, a derivative, an empty or oversized file", () => {
		expect(selectAlibabaCloudScreenshot([])).toBeUndefined();
		expect(selectAlibabaCloudScreenshot([artifact(1n, Buffer.from("GIF89a123"), { mimeType: "image/gif" })])).toBeUndefined();
		expect(selectAlibabaCloudScreenshot([artifact(1n, Buffer.from("not an image"))])).toBeUndefined();
		expect(selectAlibabaCloudScreenshot([artifact(1n, PNG, { kind: "derived" })])).toBeUndefined();
		expect(selectAlibabaCloudScreenshot([artifact(1n, Buffer.alloc(0))])).toBeUndefined();
		expect(selectAlibabaCloudScreenshot([artifact(1n, PNG, { size: PNG.byteLength + 1 })])).toBeUndefined();
	});
});

describe("report object", () => {
	test("is the first observed URL that belongs to the target", () => {
		expect(alibabaReportObject(target, [`https://other.example/a`, `https://${target}/signin`, `https://${target}/second`])).toBe(`https://${target}/signin`);
		expect(alibabaReportObject(target, [`https://sub.${target}/x`])).toBe(`https://sub.${target}/x`);
	});

	test("falls back to the host when nothing observed belongs to the target or there is nothing observed", () => {
		expect(alibabaReportObject(target, [])).toBe(target);
		expect(alibabaReportObject(target, ["https://evil.example/", "not a url", `https://${target}.evil.example/`])).toBe(target);
	});

	test("skips a URL longer than 200 characters, but keeps one of exactly 200", () => {
		const base = `https://${target}/`;
		const exact = base + "a".repeat(200 - base.length);
		expect(exact.length).toBe(200);
		expect(alibabaReportObject(target, [exact + "b", exact])).toBe(exact);
		expect(alibabaReportObject(target, [exact + "b"])).toBe(target);
		expect(alibabaReportObject(target, [exact + "b", `https://${target}/short`])).toBe(`https://${target}/short`);
	});

	test("skips a URL that carries a second http or www, which the form's pattern refuses", () => {
		expect(alibabaReportObject(target, [`https://${target}/r?u=https://victim.example/`])).toBe(target);
		expect(alibabaReportObject(target, [`https://${target}/r?u=www.victim.example`])).toBe(target);
		expect(alibabaReportObject(target, [`https://${target}/go?next=HTTP://x.example`])).toBe(target);
		expect(alibabaReportObject(target, [`https://${target}/r?u=https://victim.example/`, `https://${target}/clean`])).toBe(`https://${target}/clean`);
		// One http is fine, also inside a path word.
		expect(alibabaReportObject(target, [`https://${target}/a/b`])).toBe(`https://${target}/a/b`);
	});

	test("an IP target keeps its URLs and falls back to the IP", () => {
		expect(alibabaReportObject("8.8.4.4", ["https://8.8.4.4/login.php"])).toBe("https://8.8.4.4/login.php");
		expect(alibabaReportObject("8.8.4.4", ["https://8.8.8.8/login.php"])).toBe("8.8.4.4");
		expect(build({ target: "8.8.4.4", observedUrls: [] }).report.reportDomainIp).toBe("8.8.4.4");
	});

	test("a target that is not a public host yields no object at all", () => {
		expect(alibabaReportObject("localhost", ["http://localhost/"])).toBeUndefined();
		expect(alibabaReportObject("10.0.0.1", [])).toBeUndefined();
		expect(buildAlibabaCloudSubmissionPayload({ ...input, target: "10.0.0.1", observedUrls: [] })).toBeUndefined();
	});
});

describe("submission payload", () => {
	test("phishing report: type, object, victim and pinned definition", () => {
		const payload = build();
		expect(payload).toMatchObject({
			adapter: "alibaba_cloud_report_v1",
			providerNarrativeVersion: 1,
			definition: { version: ALIBABA_CLOUD_PROVIDER.version, contentHash: ALIBABA_CLOUD_PROVIDER.contentHash },
			target: { normalizedTarget: target },
			report: { typeReport: "Phishing Scams", reportDomainIp: `https://${target}/signin`, impactItem: "https://www.examplebank.com/login" },
			screenshot,
		});
		expect(payload.report.reportReason.length).toBeGreaterThan(0);
	});

	test("a malware report is 'Illegal Activities'; any other category is phishing", () => {
		expect(build({ allegationCategory: "malware" }).report.typeReport).toBe("Illegal Activities");
		expect(build({ allegationCategory: "phishing" }).report.typeReport).toBe("Phishing Scams");
		expect(build({ allegationCategory: "scam" }).report.typeReport).toBe("Phishing Scams");
		const { allegationCategory: _omitted, ...without } = input;
		expect(buildAlibabaCloudSubmissionPayload(without)?.report.typeReport).toBe("Phishing Scams");
	});

	test("the victim is the impersonated brand's URL when known, otherwise the fixed fallback", () => {
		expect(build({ legalBrandUrl: null }).report.impactItem).toBe(ALIBABA_CLOUD_PROVIDER.victimFallback);
		expect(build({ legalBrandUrl: "" }).report.impactItem).toBe(ALIBABA_CLOUD_PROVIDER.victimFallback);
		expect(build({ legalBrandUrl: "not a url" }).report.impactItem).toBe(ALIBABA_CLOUD_PROVIDER.victimFallback);
		expect(build({ legalBrandUrl: "javascript:alert(1)" }).report.impactItem).toBe(ALIBABA_CLOUD_PROVIDER.victimFallback);
		expect(build({ legalBrandUrl: "https://www.examplebank.com/deep/path?x=1" }).report.impactItem).toBe("https://www.examplebank.com/deep/path?x=1");
	});

	test("the reason is at most 1,000 characters, however long the description", () => {
		const long = `${"The page copies the login form of the bank and posts the credentials to a collector. ".repeat(40)}`;
		const reason = makeAlibabaCloudReportReason({ ...input, description: long });
		expect(reason!.length).toBeLessThanOrEqual(1_000);
		expect(build({ description: long, observedUrls: Array.from({ length: 50 }, (_, i) => `https://${target}/p${i}`) }).report.reportReason.length).toBeLessThanOrEqual(1_000);
	});

	test("builds nothing without an intact screenshot reference", () => {
		expect(buildAlibabaCloudSubmissionPayload({ ...input, screenshot: { ...screenshot, filename: "evil.png" } })).toBeUndefined();
		expect(buildAlibabaCloudSubmissionPayload({ ...input, screenshot: { ...screenshot, sha256: "z".repeat(64) } })).toBeUndefined();
		expect(buildAlibabaCloudSubmissionPayload({ ...input, screenshot: { ...screenshot, mimeType: "image/gif" as never } })).toBeUndefined();
	});
});

describe("stored payload", () => {
	test("round-trips exactly and carries no extra properties", () => {
		const payload = build();
		expect(storedAlibabaCloudSubmissionPayload(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
		expect(storedAlibabaCloudSubmissionPayload({ ...payload, extra: "dropped", report: { ...payload.report, injected: "x" } })).toEqual(payload);
	});

	test("rejects tampering with each pinned or typed part", () => {
		const payload = build();
		const tampered: unknown[] = [
			undefined, null, "payload", [], {},
			{ ...payload, adapter: "other" },
			{ ...payload, providerNarrativeVersion: 2 },
			{ ...payload, definition: { ...payload.definition, version: "1999" } },
			{ ...payload, definition: { ...payload.definition, contentHash: "0".repeat(64) } },
			{ ...payload, definition: undefined },
			{ ...payload, target: { normalizedTarget: 5 } },
			{ ...payload, target: undefined },
			{ ...payload, report: undefined },
			{ ...payload, screenshot: undefined },
			{ ...payload, screenshot: { ...payload.screenshot, filename: "x.png" } },
			{ ...payload, screenshot: { ...payload.screenshot, sha256: "A".repeat(64) } },
			{ ...payload, report: { ...payload.report, reportDomainIp: "x".repeat(201) } },
			{ ...payload, report: { ...payload.report, reportReason: "x".repeat(1_001) } },
		];
		for (const field of ["typeReport", "reportDomainIp", "reportReason", "impactItem"] as const) {
			tampered.push({ ...payload, report: { ...payload.report, [field]: "" } }, { ...payload, report: { ...payload.report, [field]: 1 } }, { ...payload, report: { ...payload.report, [field]: undefined } });
		}
		for (const value of tampered) expect(storedAlibabaCloudSubmissionPayload(value)).toBeUndefined();
		// Boundaries stay valid.
		expect(storedAlibabaCloudSubmissionPayload({ ...payload, report: { ...payload.report, reportDomainIp: "x".repeat(200), reportReason: "y".repeat(1_000) } })).toBeDefined();
	});
});

describe("SubmitReportTask parameters", () => {
	const evidence = { fileName: "proof.png", filePath: "report/2026-11-20/proof.png/faa3c1d0" };

	test("equal the browser form's own shape for a website report", () => {
		const payload = build();
		expect(alibabaCloudSubmitParams(payload, evidence, false)).toEqual({
			carrierReport: "Website",
			reportOccurred: false,
			lossMoneyOccurred: false,
			otherFraudResourceInvolved: false,
			typeReport: "Phishing Scams",
			reportDomainIp: `https://${target}/signin`,
			reportReason: payload.report.reportReason,
			reportEvidenceFile: [{ fileName: "proof.png", filePath: evidence.filePath, originalName: "proof.png" }],
			impactItem: "https://www.examplebank.com/login",
			reporterPublic: "Phishing Support",
			emailPublic: "support@phishing.support",
			area: "Germany",
			pageType: "harmInfo",
			foundDeceiveTime: "",
		});
	});

	test("allowCrossRegion is present only when the console said the resource is cross-region", () => {
		const payload = build();
		expect("allowCrossRegion" in alibabaCloudSubmitParams(payload, evidence, false)).toBeFalse();
		expect(alibabaCloudSubmitParams(payload, evidence, true)).toMatchObject({ allowCrossRegion: true });
	});

	test("serializes with the browser's key order and no undefined values", () => {
		const keys = Object.keys(alibabaCloudSubmitParams(build(), evidence, true));
		expect(keys).toEqual(["carrierReport", "reportOccurred", "lossMoneyOccurred", "otherFraudResourceInvolved", "typeReport", "reportDomainIp", "reportReason", "reportEvidenceFile", "impactItem", "reporterPublic", "emailPublic", "area", "pageType", "foundDeceiveTime", "allowCrossRegion"]);
		expect(JSON.parse(JSON.stringify(alibabaCloudSubmitParams(build(), evidence, true)))).toEqual(alibabaCloudSubmitParams(build(), evidence, true));
	});
});
