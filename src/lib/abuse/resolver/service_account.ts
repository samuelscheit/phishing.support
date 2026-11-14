import type { ResolvedAbuseTarget, ResolverTarget } from "./types";
import { emailRoute } from "./routes";

const TELEGRAM_BOT = /^telegram-bot:(\d{1,20})$/;
const DISCORD_WEBHOOK = /^discord-webhook:(\d{1,20})$/;

/** Route shared-service identities to the service, never to its registrar or hosting network. */
export function resolveServiceAccountTarget(target: ResolverTarget): ResolvedAbuseTarget {
	const snapshot = {
		target: target.normalizedTarget,
		targetType: target.targetType,
		observedUrls: target.observedUrls,
	};
	if (TELEGRAM_BOT.test(target.normalizedTarget)) {
		return {
			status: "resolved",
			resolverSnapshot: snapshot,
			routes: [emailRoute({
				email: "abuse@telegram.org",
				providerName: "Telegram Abuse",
				provenance: { source: "service_account_registry", service: "telegram", accountType: "bot" },
				snapshot,
			})],
		};
	}
	// The webhook itself is deleted by the supplemental `discord_webhook`
	// provider; Trust & Safety gets the evidence to act on the account behind it.
	if (DISCORD_WEBHOOK.test(target.normalizedTarget)) {
		return {
			status: "resolved",
			resolverSnapshot: snapshot,
			routes: [emailRoute({
				email: "abuse@discord.com",
				providerName: "Discord Trust & Safety",
				provenance: { source: "service_account_registry", service: "discord", accountType: "webhook" },
				snapshot,
			})],
		};
	}
	return {
		status: "no_route",
		disposition: "unknown_service_account",
		resolverSnapshot: snapshot,
		routes: [{
			routeKey: `manual:${target.normalizedTarget}`,
			providerRegistryKey: "manual_unroutable",
			providerDisplayName: "No verified service abuse route",
			routeType: "manual_unroutable",
			resolverProvenance: { reason: "unknown_service_account" },
			resolutionSnapshot: snapshot,
			status: "no_route",
		}],
	};
}
