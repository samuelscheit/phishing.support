import { isIP } from "node:net";
import { simpleParser } from "mailparser";

import type { AbuseArtifact, AbuseTargetType } from "../schema";
import { normalizePublicHttpUrl } from "../security";
import { getMailWebsiteUrls } from "../../mail";
import { compactProviderText } from "./report_payload";

/** The most links a provider form is shown from one email. */
const MAXIMUM_EMAIL_LINKS = 20;

/** What a phishing email's stored source proves about the host that sent it. */
export type EmailOrigin = {
	/** The email's web links (deduplicated): the phishing URLs it pushes. */
	links: string[];
	/** The Received header the sending host added, with the time it states. */
	received?: { line: string; at: Date };
};

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
	return { links, ...(received ? { received } : {}) };
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
