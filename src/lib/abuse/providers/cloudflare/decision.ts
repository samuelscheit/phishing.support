import { sentenceContaining } from "../../../util/text";
import type { ProviderDecision, ProviderDecisionSource } from "../submission_contracts";

/** Cloudflare's denial when its own request to the URLs got nothing: a cloaked page serves its content only to the clients it targets. */
const NOT_VISIBLE = "Declined: content not visible";

/**
 * What Cloudflare decided, from its "Response to your … report" email or the
 * state its submitted-reports API gives. The email states its action in
 * fixed sentences: "We have restricted access to the reported URL(s)." (a
 * warning interstitial in front of the site, case 384401854580134038), "The
 * reported content is no longer visible at the URLs included in your
 * complaint." (it closed the report: its request got no content), or only
 * that the report went to the website owner and its host. The API's `denied`
 * carries the reason (`content_removed`); `accepted` is a report taken on.
 */
export function cloudflareDecision({ text, state, detail }: ProviderDecisionSource): ProviderDecision | undefined {
	if (text) {
		const restricted = sentenceContaining(text, /\bwe have restricted access to the reported URL/i);
		if (restricted) return { outcome: "action_taken", label: "Access restricted", sentence: restricted };
		const gone = sentenceContaining(text, /\bno longer visible at the URLs\b/i);
		if (gone) return { outcome: "declined", label: NOT_VISIBLE, sentence: gone };
		const forwarded = sentenceContaining(text, /\bforwarded to the website owner\b|\bforwarded this report to the relevant hosting provider\b/i);
		if (forwarded) return { outcome: "received", label: "Forwarded to the host", sentence: forwarded };
		return undefined;
	}
	if (state === "denied") return { outcome: "declined", label: detail === "content_removed" ? NOT_VISIBLE : "Declined" };
	if (state === "accepted") return { outcome: "received", label: "Accepted" };
	return undefined;
}
