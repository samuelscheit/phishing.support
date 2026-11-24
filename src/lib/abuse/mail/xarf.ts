import { isIP } from "node:net";

import { createReport } from "@xarf/xarf";
import { simpleParser, type AddressObject } from "mailparser";

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
	/** The phishing mail a sending address is reported for (`xarfMessageOf`), when the report names no page. */
	message?: XarfMessage;
	/**
	 * Files that ride inside the report, base64 with their SHA-256, as many as
	 * fit the spec's limits: for a mailbox that reads nothing but XARF. A report
	 * attached beside the files leaves them out, so the mail's size stays.
	 */
	evidence?: readonly AbuseMailAttachment[];
};

/** The headers of a reported phishing mail that XARF's messaging report names. */
export type XarfMessage = { smtpFrom: string; senderName?: string; subject?: string; messageId?: string };

/**
 * The XARF v4 report of one abuse mail, validated against the official
 * schemas: a `content` report of the reported page, or, for an address
 * reported for the phishing mail it sent and no page, a `messaging/spam`
 * report of that mail. Undefined when the allegation has no XARF type or the
 * report names neither.
 */
export function buildXarfReport(input: XarfReportInput): Record<string, unknown> | undefined {
	const type = CONTENT_TYPES[input.allegationCategory];
	if (!type) return undefined;
	const fields = contentFields(input, type) ?? (input.message ? messagingFields(input, input.message) : undefined);
	if (!fields) return undefined;
	const { report, errors } = createReport({
		report_id: input.reportId,
		timestamp: input.observedAt.toISOString(),
		reporter,
		sender: reporter,
		...fields,
		...(input.caseUrl ? { screenshot_url: input.caseUrl } : {}),
		...evidenceOf(input.evidence ?? []),
		description: input.description.slice(0, 1_000),
	} as Parameters<typeof createReport>[0]);
	if (errors.length) throw new Error(`The XARF report does not validate: ${errors.map((error) => typeof error === "string" ? error : `${error.field}: ${error.message}`).join("; ")}`);
	return report as unknown as Record<string, unknown>;
}

/** The reported page: the first public observed URL, a domain's root otherwise; an address alone names none. */
function contentFields(input: XarfReportInput, type: string): Record<string, unknown> | undefined {
	const url = input.observedUrls.map((value) => normalizePublicHttpUrl(value)).find(Boolean)
		?? (isIP(input.target) ? undefined : normalizePublicHttpUrl(`https://${input.target}/`));
	if (!url) return undefined;
	const host = new URL(url).hostname;
	const clonedSite = input.legalBrandUrl ? normalizePublicHttpUrl(input.legalBrandUrl, { domainOnly: true }) : undefined;
	// Fields a type requires beyond the content base; brand infringement names the legitimate site, so it needs the brand's.
	const typeFields: Record<string, unknown> | undefined = type === "fraud"
		? { fraud_type: "other" }
		: type === "brand_infringement"
			? clonedSite ? { infringement_type: "brand_impersonation", legitimate_site: clonedSite } : undefined
			: {};
	if (!typeFields) return undefined;
	return {
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
	};
}

/** The phishing mail the reported address sent over SMTP; XARF files unsolicited mail of every kind as spam. */
function messagingFields(input: XarfReportInput, message: XarfMessage): Record<string, unknown> {
	return {
		source_identifier: input.sourceIp ?? input.target,
		source_port: 25,
		category: "messaging",
		type: "spam",
		protocol: "smtp",
		smtp_from: message.smtpFrom,
		...(message.senderName ? { sender_name: message.senderName.slice(0, 200) } : {}),
		...(message.subject ? { subject: message.subject.slice(0, 500) } : {}),
		...(message.messageId && message.messageId.length <= 200 ? { message_id: message.messageId } : {}),
		evidence_source: "user_complaint",
	};
}

/**
 * The headers of the first attached mail (.eml, message/rfc822): the
 * envelope sender as its Return-Path records it, else the From address.
 * Undefined without a mail or a sender.
 */
export async function xarfMessageOf(attachments: readonly AbuseMailAttachment[]): Promise<XarfMessage | undefined> {
	const file = attachments.find((attachment) => attachment.mimeType.toLowerCase() === "message/rfc822" || attachment.filename.toLowerCase().endsWith(".eml"));
	if (!file) return undefined;
	const mail = await simpleParser(file.content, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
	// mailparser reads Return-Path as an address list; a bare string when it cannot.
	const returnPath = mail.headers.get("return-path") as AddressObject | string | undefined;
	const envelope = typeof returnPath === "string" ? returnPath.replace(/^<|>$/g, "").trim() : returnPath?.value[0]?.address;
	const from = mail.from?.value[0];
	const smtpFrom = [envelope, from?.address].find((address): address is string => Boolean(address && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)));
	if (!smtpFrom) return undefined;
	return {
		smtpFrom,
		...(from?.name ? { senderName: from.name } : {}),
		...(mail.subject ? { subject: mail.subject } : {}),
		...(mail.messageId ? { messageId: mail.messageId } : {}),
	};
}

/** Files carried inside the report, as many as fit the spec's limits. */
function evidenceOf(files: readonly AbuseMailAttachment[]): { evidence?: Record<string, unknown>[] } {
	let budget = MAXIMUM_TOTAL_EVIDENCE_BYTES;
	const evidence = files.flatMap((file) => {
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
	return evidence.length ? { evidence } : {};
}

/** The report as the `xarf.json` file every abuse mail it exists for carries. */
export function xarfAttachment(report: Record<string, unknown>): AbuseMailAttachment {
	return { filename: "xarf.json", mimeType: "application/json", content: Buffer.from(JSON.stringify(report)) };
}

/**
 * The machine-readable parts of an XARF-only mail (xarf.org email transport):
 * the RFC 5965 feedback report that names it, then xarf.json. They follow the
 * human-readable text part inside `multipart/report; report-type=feedback-report`.
 */
export function xarfMailParts(report: Record<string, unknown>) {
	const file = xarfAttachment(report);
	return [
		{
			content: `Feedback-Type: xarf\r\nUser-Agent: ${serviceUserAgent}\r\nVersion: 1\r\n`,
			contentType: "message/feedback-report",
			contentDisposition: "inline" as const,
		},
		{
			filename: file.filename,
			content: file.content,
			contentType: file.mimeType,
			contentTransferEncoding: "base64" as const,
		},
	];
}

export const XARF_CONTENT_TYPE = "multipart/report; report-type=feedback-report";
