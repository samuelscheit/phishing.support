import type { ResolvedAbuseTarget, ResolverTarget } from "./types";
import { emailRoute } from "../providers";

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
	// Discord reviews no abuse mail ("We're unable to review email submissions
	// to abuse@discord.com"). Its routes are the supplemental providers that
	// match the webhook URL: `discord_webhook` deletes the webhook and
	// `discord_dsa` files a DSA notice about its server; this placeholder only
	// stands in until they replace it.
	if (DISCORD_WEBHOOK.test(target.normalizedTarget)) {
		return {
			status: "no_route",
			disposition: "discord_webhook_handled_by_its_providers",
			resolverSnapshot: snapshot,
			routes: [{
				routeKey: `manual:${target.normalizedTarget}`,
				providerRegistryKey: "manual_unroutable",
				providerDisplayName: "Discord",
				routeType: "manual_unroutable",
				resolverProvenance: { source: "service_account_registry", service: "discord", reason: "discord_reviews_no_abuse_mail" },
				resolutionSnapshot: snapshot,
				status: "no_route",
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
