import { isIP } from "node:net";
import { simpleParser } from "mailparser";

import type { AbuseArtifact, AbuseTargetType } from "../schema";
import { normalizePublicHttpUrl } from "../security";
import { getMailWebsiteUrls } from "../../mail";
import { compactProviderText, truncateProviderText } from "./report_payload";

/** The most links a provider form is shown from one email. */
const MAXIMUM_EMAIL_LINKS = 20;

/** What a phishing email's stored source proves about the host that sent it. */
export type EmailOrigin = {
	/** The email's web links (deduplicated): the phishing URLs it pushes. */
	links: string[];
	/** The Received header the sending host added, with the time it states. */
	received?: { line: string; at: Date };
	/** The message's header block as stored (already redacted), lines joined by LF, without the body. */
	headers: string;
};

/** The header block of an RFC 822 source: everything before the first blank line. */
function headerBlockOf(eml: string): string {
	const text = eml.replace(/\r\n?/g, "\n");
	const end = text.indexOf("\n\n");
	return (end >= 0 ? text.slice(0, end) : text).replace(/^\n+/, "").trimEnd();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The Received header that names `ip`, with the UTC time after its last semicolon. */
export function receivedHopOf(receivedLines: readonly string[], ip: string): EmailOrigin["received"] {
	const named = new RegExp(`(?<![\\w.:])${escapeRegExp(ip)}(?![\\w.:])`, "i");
	for (const raw of receivedLines) {
		const line = compactProviderText(raw.replace(/^received\s*:\s*/i, ""));
		if (!named.test(line)) continue;
		const stamp = line.slice(line.lastIndexOf(";") + 1).trim();
		const at = line.includes(";") ? new Date(stamp) : undefined;
		return at && Number.isFinite(at.getTime()) ? { line, at } : undefined;
	}
	return undefined;
}

/** Read the links and the sending hop of `ip` from a phishing email's RFC 822 source. */
export async function parseEmailOrigin(eml: Buffer | string, ip: string): Promise<EmailOrigin> {
	const parsed = await simpleParser(eml);
	const links = [...new Set(getMailWebsiteUrls({ html: parsed.html || "", text: parsed.text ?? "" })
		.map((url) => normalizePublicHttpUrl(url))
		.filter((url): url is string => Boolean(url)))].slice(0, MAXIMUM_EMAIL_LINKS);
	const receivedLines = parsed.headerLines.filter((header) => header.key === "received").map((header) => header.line);
	const received = receivedHopOf(receivedLines, ip);
	return { links, headers: headerBlockOf(Buffer.isBuffer(eml) ? eml.toString("utf8") : eml), ...(received ? { received } : {}) };
}

/**
 * The origin evidence of an IP target that sent a phishing email: the report
 * holds the email's source and the target is the address of its sending hop.
 * Undefined for any other target, e.g. a bare IP or an IP hosting a website.
 */
export async function emailOriginOf(params: {
	target: { targetType: AbuseTargetType; normalizedTarget: string };
	evidenceArtifacts: readonly Pick<AbuseArtifact, "mimeType" | "blob">[];
}): Promise<EmailOrigin | undefined> {
	if (params.target.targetType !== "ip" || !isIP(params.target.normalizedTarget)) return undefined;
	const message = params.evidenceArtifacts.find((artifact) => artifact.mimeType === "message/rfc822");
	return message ? parseEmailOrigin(Buffer.from(message.blob), params.target.normalizedTarget) : undefined;
}

/** An ISO time without milliseconds, e.g. 2026-11-19T09:00:01Z. */
export function utcStamp(date: Date): string {
	return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * What a provider is told about the host that sent a phishing email: the
 * address, the Received header that proves the hop, and the time it states
 * (UTC; `fallback` when no header states one).
 */
export function emailOriginFactLines(ip: string, origin: EmailOrigin, fallback: Date, receivedMaximum = 600): string[] {
	return [
		`Sending IP address: ${ip} (first external Received hop of a phishing email sent from it)`,
		origin.received ? `Received header: ${truncateProviderText(origin.received.line, receivedMaximum)}` : undefined,
		`Date and time of the email: ${utcStamp(origin.received?.at ?? fallback)} (UTC)`,
	].filter((line): line is string => Boolean(line));
}
