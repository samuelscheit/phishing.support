import { netcraftSubmissionIdsFromText } from "../../../netcraft/api";
import type { AbuseMailClassification } from "../../schema";
import type { ProviderInboundMail } from "../submission_contracts";

/**
 * The verdict of Netcraft's "We've analysed your submission" and "We've
 * updated the classification" mails: "has been classified as malicious", or
 * "no threats were found". Its "Thanks for your report" receipt states none.
 */
export function netcraftNotificationVerdict(text: string): AbuseMailClassification | undefined {
	const flat = text.replace(/\s+/g, " ");
	if (/\bno threats were found\b/i.test(flat)) return "rejected";
	if (/\bclassified as (?:malicious|suspicious|phishing|malware)\b/i.test(flat)) return "acknowledged";
	return undefined;
}

/** Netcraft's report-update emails name the submission they are about in their result links. */
export const NETCRAFT_INBOUND_MAIL: ProviderInboundMail = {
	senderDomains: ["netcraft.com"],
	confirmationIds: netcraftSubmissionIdsFromText,
	verdictOf: netcraftNotificationVerdict,
};
