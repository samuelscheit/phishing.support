import { createReport } from "@xarf/xarf";

import { serviceIdentity, serviceUserAgent } from "../../network/service_identity";
import { sha256Hex } from "../../util/hash";
import { normalizePublicHttpUrl } from "../security/security";
import type { AbuseMailAttachment } from "./types";

/** XARF v4 content types per allegation; an allegation without one is not sent as XARF. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
	phishing: "phishing",
	malware: "malware",
	fraud: "fraud",
	impersonation: "brand_infringement",
};
/** The spec's per-item evidence limit, and what a report carries in all (the spec advises at most 15 MB of mail). */
const MAXIMUM_EVIDENCE_BYTES = 5_242_880;
const MAXIMUM_TOTAL_EVIDENCE_BYTES = 10_000_000;
/** content-base's `domain` pattern: lowercase LDH labels without `--`, so IDNs stay out. */
const XARF_DOMAIN = /^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/;

const reporter = { org: serviceIdentity.name, contact: serviceIdentity.mailbox, domain: new URL(serviceIdentity.url).hostname };

export type XarfReportInput = {
	/** UUID v4 of this report. */
	reportId: string;
	allegationCategory: string;
	/** When the content was captured. */
	observedAt: Date;
	target: string;
	observedUrls: readonly string[];
	/** The address the site is served from, when known; the source is the domain otherwise. */
	sourceIp?: string;
	legalBrandUrl?: string | null;
	/** One line: what is reported. */
	description: string;
	caseUrl?: string;
	evidence: readonly AbuseMailAttachment[];
};

/**
 * The XARF v4 report of one abuse mail, validated against the official
 * schemas; undefined when the allegation has no XARF content type or nothing
 * names a reported page. Evidence files ride inside it, base64 with their
 * SHA-256, as many as fit the spec's limits.
 */
export function buildXarfReport(input: XarfReportInput): Record<string, unknown> | undefined {
	const type = CONTENT_TYPES[input.allegationCategory];
	const url = input.observedUrls.map((value) => normalizePublicHttpUrl(value)).find(Boolean) ?? normalizePublicHttpUrl(`https://${input.target}/`);
	if (!type || !url) return undefined;
	const host = new URL(url).hostname;
	const clonedSite = input.legalBrandUrl ? normalizePublicHttpUrl(input.legalBrandUrl, { domainOnly: true }) : undefined;
	// Fields a type requires beyond the content base; brand infringement names the legitimate site, so it needs the brand's.
	const typeFields: Record<string, unknown> | undefined = type === "fraud"
		? { fraud_type: "other" }
		: type === "brand_infringement"
			? clonedSite ? { infringement_type: "brand_impersonation", legitimate_site: clonedSite } : undefined
			: {};
	if (!typeFields) return undefined;
	let budget = MAXIMUM_TOTAL_EVIDENCE_BYTES;
	const evidence = input.evidence.flatMap((file) => {
		if (file.content.byteLength > MAXIMUM_EVIDENCE_BYTES || file.content.byteLength > budget) return [];
		budget -= file.content.byteLength;
		return [{
			content_type: file.mimeType,
			description: file.filename.slice(0, 500),
			payload: file.content.toString("base64"),
			hash: `sha256:${sha256Hex(file.content)}`,
			size: file.content.byteLength,
		}];
	});
	const { report, errors } = createReport({
		report_id: input.reportId,
		timestamp: input.observedAt.toISOString(),
		reporter,
		sender: reporter,
		source_identifier: input.sourceIp ?? host,
		...(url.startsWith("https:") ? { source_port: 443 } : {}),
		category: "content",
		type,
		...typeFields,
		url,
		...(XARF_DOMAIN.test(host) ? { domain: host } : {}),
		...(clonedSite && type === "phishing" ? { cloned_site: clonedSite } : {}),
		...(clonedSite ? { target_brand: new URL(clonedSite).hostname.replace(/^www\./, "") } : {}),
		evidence_source: "automated_crawler",
		verification_method: "automated_crawler",
		...(input.caseUrl ? { screenshot_url: input.caseUrl } : {}),
		...(evidence.length ? { evidence } : {}),
		description: input.description.slice(0, 1_000),
	} as Parameters<typeof createReport>[0]);
	if (errors.length) throw new Error(`The XARF report does not validate: ${errors.map((error) => typeof error === "string" ? error : `${error.field}: ${error.message}`).join("; ")}`);
	return report as unknown as Record<string, unknown>;
}

/**
 * The machine-readable parts of an XARF mail (xarf.org email transport): the
 * RFC 5965 feedback report that names it, then xarf.json. They follow the
 * human-readable text part inside `multipart/report; report-type=feedback-report`.
 */
export function xarfMailParts(report: Record<string, unknown>) {
	return [
		{
			content: `Feedback-Type: xarf\r\nUser-Agent: ${serviceUserAgent}\r\nVersion: 1\r\n`,
			contentType: "message/feedback-report",
			contentDisposition: "inline" as const,
		},
		{
			filename: "xarf.json",
			content: Buffer.from(JSON.stringify(report)),
			contentType: "application/json",
			contentTransferEncoding: "base64" as const,
		},
	];
}

export const XARF_CONTENT_TYPE = "multipart/report; report-type=feedback-report";
