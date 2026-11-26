import { cleanMailText, type CleanMailText } from "../mail/clean_text";
import type { AbuseMailMessage, AbuseProviderRoute } from "../schema";
import { getProviderSubmissionProvider } from "./submission_registry_default";
import type { ProviderDecision } from "./submission_contracts";

export type ReadMessage = {
	/** A review state the provider's API reported ("accepted", "denied" with its reason), recorded by our poll: no message of the provider's own. */
	providerState: { state: string; detail: string | null } | null;
	/** The body as clean text; null for a review-state record or an empty body. */
	text: CleanMailText | null;
	/** What the provider decided, as this inbound message or state says it, read by the provider's own rules. */
	decision: ProviderDecision | undefined;
};

/** A stored message as its provider means it: a review-state record told apart from a message, its text cleaned, and the decision it states. */
export function readProviderMessage(
	route: Pick<AbuseProviderRoute, "providerRegistryKey">,
	message: Pick<AbuseMailMessage, "direction" | "correlationKey" | "subject" | "textBody">,
): ReadMessage {
	const provider = getProviderSubmissionProvider(route.providerRegistryKey);
	const providerState = message.correlationKey?.startsWith(`provider-api:${route.providerRegistryKey}:status:`)
		? { state: (message.subject ?? "").replace(/^Report status:\s*/, ""), detail: message.textBody || null }
		: null;
	const text = !providerState && message.textBody?.trim() ? cleanMailText(message.textBody) : null;
	const decision = message.direction !== "inbound" || !provider?.decisionOf ? undefined
		: providerState ? provider.decisionOf({ state: providerState.state, ...(providerState.detail ? { detail: providerState.detail } : {}) })
		: text ? provider.decisionOf({ text: text.main }) : undefined;
	return { providerState, text, decision };
}
