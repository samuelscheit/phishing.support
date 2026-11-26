import { netcraftSubmissionIdsFromText } from "./api";
import type { AbuseMailClassification } from "../../schema";
import type { ProviderDecision, ProviderDecisionSource, ProviderInboundMail } from "../submission_contracts";
import { sentenceContaining } from "../../../util/text";

const BLOCKED = /\bclassified as (?:malicious|suspicious|phishing|malware)\b/i;
const NO_THREAT = /\bno threats were found\b/i;

/**
 * What Netcraft decided, from its "We've analysed your submission" and
 * "We've updated the classification" mails ("has been classified as
 * malicious": it blocks the site in its feeds and starts its own takedown;
 * "no threats were found": its automatic analysis found nothing), or from its
 * API state (`malicious`, `suspicious`, `no threats`). Its "Thanks for your
 * report" receipt and the `processing` state decide nothing.
 */
export function netcraftDecision({ text, state }: ProviderDecisionSource): ProviderDecision | undefined {
	if (text) {
		const blocked = sentenceContaining(text, BLOCKED);
		if (blocked) return { outcome: "action_taken", label: "Blocklisted", sentence: blocked };
		const clean = sentenceContaining(text, NO_THREAT);
		const excerpt = clean && /\b(?:automatically analysed, and )?no threats were found\b\.?/i.exec(clean)?.[0];
		if (clean) return { outcome: "no_threat", label: "No threat found", sentence: clean, ...(excerpt ? { excerpt: excerpt.charAt(0).toUpperCase() + excerpt.slice(1) } : {}) };
		return undefined;
	}
	if (state === "malicious" || state === "suspicious") return { outcome: "action_taken", label: "Blocklisted" };
	if (state === "no threats") return { outcome: "no_threat", label: "No threat found" };
	return undefined;
}

/** The verdict a Netcraft notification states, in the reply classifier's terms. */
export function netcraftNotificationVerdict(text: string): AbuseMailClassification | undefined {
	const decision = netcraftDecision({ text });
	return decision?.outcome === "action_taken" ? "acknowledged" : decision?.outcome === "no_threat" ? "rejected" : undefined;
}

/** Netcraft's report-update emails name the submission they are about in their result links. */
export const NETCRAFT_INBOUND_MAIL: ProviderInboundMail = {
	senderDomains: ["netcraft.com"],
	confirmationIds: netcraftSubmissionIdsFromText,
	verdictOf: netcraftNotificationVerdict,
};
