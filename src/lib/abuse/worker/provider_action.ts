import { checkSoonAfter } from "../../liveness/schedule";
import { readProviderMessage } from "../providers/message_decision";
import type { AbuseMailMessage, AbuseProviderRoute } from "../schema";

/**
 * A provider that acted on the reported site (a CDN's block, a host's
 * suspension) has its target checked within the hour, so an operator who
 * answers by moving the site is caught the same day.
 */
export async function recheckAfterProviderAction(
	route: Pick<AbuseProviderRoute, "providerRegistryKey" | "targetId">,
	messages: ReadonlyArray<Pick<AbuseMailMessage, "direction" | "correlationKey" | "subject" | "textBody" | "occurredAt">>,
): Promise<void> {
	const acted = messages.filter((message) => readProviderMessage(route, message).decision?.outcome === "action_taken").at(-1);
	if (acted) await checkSoonAfter(route.targetId, acted.occurredAt);
}
