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
	if (DISCORD_WEBHOOK.test(target.normalizedTarget)) {
		return {
			status: "resolved",
			disposition: "discord_webhook_requires_human_report",
			resolverSnapshot: snapshot,
			routes: [{
				routeKey: `manual:discord:${target.normalizedTarget}`,
				providerRegistryKey: "discord_webhook_manual",
				providerDisplayName: "Discord Trust & Safety",
				routeType: "manual_unroutable",
				resolverProvenance: { source: "service_account_registry", service: "discord", reason: "no_supported_webhook_report_api" },
				resolutionSnapshot: snapshot,
				status: "needs_human",
			}],
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
