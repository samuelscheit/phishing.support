import { describe, expect, test } from "bun:test";
import { parse } from "@xarf/xarf";

import { buildXarfReport, type XarfReportInput } from "./xarf";

const input = (overrides: Partial<XarfReportInput> = {}): XarfReportInput => ({
	reportId: "11111111-1111-4111-8111-111111111111",
	allegationCategory: "phishing",
	observedAt: new Date("2026-11-22T06:04:44.000Z"),
	target: "login.example.run",
	observedUrls: ["https://login.example.run/signin?x=1"],
	description: "Phishing abuse: login.example.run",
	evidence: [],
	...overrides,
});

describe("XARF report", () => {
	test("validates against the official schemas; the domain is the source when no address is known", () => {
		const report = buildXarfReport(input({ caseUrl: "https://phishing.support/submissions/1" }))!;
		expect(parse(report).errors).toEqual([]);
		expect(report).toMatchObject({ report_id: "11111111-1111-4111-8111-111111111111", timestamp: "2026-11-22T06:04:44.000Z", source_identifier: "login.example.run", source_port: 443, domain: "login.example.run", screenshot_url: "https://phishing.support/submissions/1" });
		expect(report).not.toHaveProperty("evidence");
		expect(report).not.toHaveProperty("target_brand");
		expect(buildXarfReport(input({ sourceIp: "2604:a880::1" }))!.source_identifier).toBe("2604:a880::1");
	});

	test("each allegation maps to its content type; one without a type is not XARF", () => {
		expect(buildXarfReport(input({ allegationCategory: "malware" }))!.type).toBe("malware");
		expect(buildXarfReport(input({ allegationCategory: "fraud" }))).toMatchObject({ type: "fraud", fraud_type: "other" });
		const impersonation = buildXarfReport(input({ allegationCategory: "impersonation", legalBrandUrl: "https://www.examplebank.com/" }))!;
		expect(parse(impersonation).errors).toEqual([]);
		expect(impersonation).toMatchObject({ type: "brand_infringement", infringement_type: "brand_impersonation", legitimate_site: "https://www.examplebank.com/", target_brand: "examplebank.com" });
		// Brand infringement must name the legitimate site.
		expect(buildXarfReport(input({ allegationCategory: "impersonation" }))).toBeUndefined();
		expect(buildXarfReport(input({ allegationCategory: "impersonation", legalBrandUrl: "https://www.examplebank.com/" }))).not.toHaveProperty("cloned_site");
		expect(buildXarfReport(input({ allegationCategory: "copyright" }))).toBeUndefined();
		expect(buildXarfReport(input({ allegationCategory: "other" }))).toBeUndefined();
	});

	test("the page: the first public URL, the target's root otherwise; an IDN or plain-http host stays valid", () => {
		expect(buildXarfReport(input({ observedUrls: ["not a url", "http://login.example.run/a"] }))).toMatchObject({ url: "http://login.example.run/a" });
		expect(buildXarfReport(input({ observedUrls: ["http://login.example.run/a"] }))).not.toHaveProperty("source_port");
		expect(buildXarfReport(input({ observedUrls: [] }))!.url).toBe("https://login.example.run/");
		const idn = buildXarfReport(input({ target: "xn--pypal-4ve.com", observedUrls: ["https://xn--pypal-4ve.com/login"] }))!;
		expect(parse(idn).errors).toEqual([]);
		expect(idn).not.toHaveProperty("domain");
		expect(idn.source_identifier).toBe("xn--pypal-4ve.com");
		expect(buildXarfReport(input({ target: "not a host", observedUrls: [] }))).toBeUndefined();
	});

	test("evidence carries its hash and size; files over the spec's limits are left out", () => {
		const small = Buffer.from("png");
		const report = buildXarfReport(input({ evidence: [
			{ filename: "website.png", mimeType: "image/png", content: small },
			{ filename: "huge.bin", mimeType: "application/octet-stream", content: Buffer.alloc(5_242_881) },
			{ filename: "a.bin", mimeType: "application/octet-stream", content: Buffer.alloc(5_000_000) },
			{ filename: "b.bin", mimeType: "application/octet-stream", content: Buffer.alloc(5_000_000) },
		] }))!;
		expect(parse(report).errors).toEqual([]);
		const evidence = report.evidence as Array<Record<string, unknown>>;
		expect(evidence.map(({ description }) => description)).toEqual(["website.png", "a.bin"]);
		expect(evidence[0]).toEqual({ content_type: "image/png", description: "website.png", payload: "cG5n", hash: `sha256:${new Bun.CryptoHasher("sha256").update(small).digest("hex")}`, size: 3 });
	});
});
