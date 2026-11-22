import type { ParsedMail } from "mailparser";

import { flattenAddresses } from "../../imap/rfc";
import { registrableDomain } from "../security/security";
import { normalizeMailbox } from "./shared";

const CASE_TAG_PREFIX = "PS-";
/** Twelve hex characters: unique per report in practice, short enough for ticket subjects. */
const CASE_TAG_LENGTH = 12;
const CASE_TAG = /\[PS-([0-9a-f]{12})\]/gi;
const CASE_URL = /phishing\.support\/submissions\/(\d{1,20})/gi;
const REPLY_PREFIX = /^\s*(?:(?:re|aw|sv|vs|fw|fwd|wg|tr|odp|res|antw|auto-reply|automatic reply)\s*(?:\[\d+\])?\s*:\s*|\[[^\]]{1,80}\]\s*|\([^)]{1,40}\)\s*)+/i;

/**
 * The case tag carried in every abuse email subject. Helpdesks that answer
 * from their own address and drop threading headers still keep the subject,
 * so the tag names the report without trusting the reply's other content.
 */
export function abuseCaseTag(reportId: bigint): string {
	return `${CASE_TAG_PREFIX}${reportId.toString(16).padStart(CASE_TAG_LENGTH, "0").slice(-CASE_TAG_LENGTH)}`;
}

/** Every case tag named in untrusted text, as written by `abuseCaseTag`. */
export function caseTagsIn(text: string): string[] {
	return [...new Set([...text.matchAll(CASE_TAG)].map((match) => `${CASE_TAG_PREFIX}${match[1]!.toLowerCase()}`))];
}

/** Submission IDs from our own case URLs quoted in a reply. */
export function caseSubmissionIdsIn(text: string): bigint[] {
	return [...new Set([...text.matchAll(CASE_URL)].map((match) => match[1]!))].map(BigInt);
}

/** Whether a reply's subject repeats the subject we sent; helpdesks add ticket text around it. */
export function subjectRepeats(replySubject: string | undefined | null, sentSubject: string | undefined | null): boolean {
	const sent = canonicalSubject(sentSubject);
	// Very short subjects would match unrelated mail.
	return sent.length >= 16 && canonicalSubject(replySubject).includes(sent);
}

/**
 * A subject without reply/forward markers or bracketed ticket and case
 * prefixes, so `[Abuse@15727218] Re: [PS-…] Abuse report for x` equals
 * the subject we sent.
 */
export function canonicalSubject(subject: string | undefined | null): string {
	let value = (subject ?? "").replace(/\s+/g, " ").trim();
	for (let previous = ""; previous !== value;) {
		previous = value;
		value = value.replace(REPLY_PREFIX, "").trim();
	}
	return value.toLowerCase();
}

/**
 * The visible sender, accepted only when the receiving server's own
 * Authentication-Results (DMARC or an aligned DKIM/SPF pass) vouch for its
 * domain. Receivers prepend headers, so their block ends at the `Received`
 * header the inbound MX added below its SPF verdict; anything further down
 * was written by the sender, so a forged result there is ignored.
 */
export function authenticatedSender(parsed: ParsedMail, trustedAuthservId: string): string | undefined {
	const senders = flattenAddresses(parsed.from).map((entry) => normalizeMailbox(entry.address)).filter((address): address is string => Boolean(address));
	if (senders.length !== 1) return undefined;
	const sender = senders[0]!;
	const senderDomain = registrableDomain(sender.slice(sender.lastIndexOf("@") + 1));
	if (!senderDomain) return undefined;

	const results: string[] = [];
	let spfVerdictSeen = false;
	for (const line of parsed.headerLines) {
		const key = line.key.toLowerCase();
		if (key === "dkim-signature" || key === "from" || key === "message-id" || key === "date") break;
		if (key === "received" && spfVerdictSeen) break;
		if (key === "received-spf") spfVerdictSeen = true;
		if (key === "authentication-results") results.push(line.line.slice(line.line.indexOf(":") + 1).replace(/\s+/g, " ").trim().toLowerCase());
	}
	const trusted = results.filter((result) => {
		const authservId = result.split(";", 1)[0]!.trim();
		return authservId === trustedAuthservId || authservId.endsWith(`.${trustedAuthservId}`);
	});
	const aligned = (domain: string | undefined) => Boolean(domain && registrableDomain(domain) === senderDomain);
	return trusted.some((result) =>
		[...result.matchAll(/\bdmarc=pass\b[^;]*?header\.from=([^\s;]+)/g)].some((match) => aligned(match[1]))
		|| [...result.matchAll(/\bdkim=pass\b[^;]*?header\.d=([^\s;]+)/g)].some((match) => aligned(match[1]))
		|| [...result.matchAll(/\bspf=pass\b[^;]*?smtp\.mailfrom=(?:[^\s;@]*@)?([^\s;]+)/g)].some((match) => aligned(match[1])),
	) ? sender : undefined;
}
