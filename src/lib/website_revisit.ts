import { FABRIC_EGRESS_LABEL, type FabricEgress } from "./browser/fabric";
import type { WebsiteNavigationHop, WebsiteRevisit } from "./website_types";

/**
 * The earlier visit's navigation, the page it ended on marked with why it was
 * opened again and which page was (`from.url`), before the revisit's own hops.
 */
export function continuedRevisit(revisit: { hops: WebsiteNavigationHop[]; from: WebsiteNavigationHop; revisit: WebsiteRevisit }): WebsiteNavigationHop[] {
	return revisit.hops.map((hop) => (hop.index === revisit.from.index ? { ...hop, contentCaptured: false, redirectTo: revisit.from.url, revisit: revisit.revisit } : hop));
}

/** The network a visit a challenge blocked is repeated from: challenges trust a residential address most. */
export const CHALLENGE_RETRY_EGRESS: FabricEgress = "residential";

/** Why a visit a challenge blocked has no verdict: every network was blocked, or the other one never reached the page. */
export function challengeInconclusive(stoppedReason: string, attempt: { retried: boolean; unreached?: string }): string {
	const blocked = `a CAPTCHA or browser check blocked it (${stoppedReason})`;
	if (attempt.unreached) return `${blocked}, and the ${FABRIC_EGRESS_LABEL[CHALLENGE_RETRY_EGRESS]} could not open the page again (${attempt.unreached}).`;
	return attempt.retried ? `${blocked} from the ${FABRIC_EGRESS_LABEL[CHALLENGE_RETRY_EGRESS]} as well.` : `${blocked}.`;
}
