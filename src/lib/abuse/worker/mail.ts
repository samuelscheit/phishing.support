import { classifyProviderReply, extractVerifiedProviderLinks } from "../mail";
import { isGenericFormEscalationEnabled, verifiedDomainsForEmailRoute } from "../registry";
import { AbuseRepository } from "../repository";

export async function classifyReply(messageId: bigint): Promise<void> {
	const message = await AbuseRepository.getMailMessage(messageId);
	if (!message) return;
	const result = await classifyProviderReply({ text: message.textBody ?? "", from: message.fromAddress ?? undefined });
	const route = await AbuseRepository.getRoute(message.routeId);
	if (!route) return;
	const links = result.classification === "not_monitored"
		? await extractVerifiedProviderLinks({
			providerKey: route.providerRegistryKey === "gname" ? route.providerRegistryKey : undefined,
			verifiedDomains: route.verifiedEmail ? verifiedDomainsForEmailRoute(route.verifiedEmail) : undefined,
			text: message.textBody ?? "",
		})
		: [];
	await AbuseRepository.setMailClassification(message.id, result.classification, links, result.rationale);
	if (result.classification === "acknowledged") {
		await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "awaiting_provider_reply", to: "acknowledged" });
	} else if (result.classification === "not_monitored" && links.length > 0 && isGenericFormEscalationEnabled()) {
		// A link only reaches this point after exact provider-origin and every
		// redirect hop was revalidated. The generic task still gets only a
		// code-owned prompt and immutable stored payload.
		if (await AbuseRepository.transitionRouteStatus({
			routeId: route.id,
			from: "awaiting_provider_reply",
			to: "escalating_to_portal",
			data: { providerLink: links[0] },
		})) {
			await AbuseRepository.enqueueJob({
				jobType: "run_portal",
				reportId: route.reportId,
				routeId: route.id,
				payload: { providerLink: links[0], sourceMailMessageId: message.id.toString() },
				dedupeKey: `generic-portal:${route.id.toString()}`,
			});
		}
	} else if (result.classification === "not_monitored") {
		await AbuseRepository.transitionRouteStatus({
			routeId: route.id,
			from: "awaiting_provider_reply",
			to: "provider_rejected",
			data: { reason: links.length ? "generic_form_escalation_disabled" : "provider_mailbox_not_monitored_without_verified_form" },
		});
	} else if (result.classification === "needs_more_information") {
		// No immutable route policy can currently determine which provider
		// questions are safely answerable from stored evidence. Finish safely
		// rather than making email text an instruction source.
		await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "awaiting_provider_reply", to: "provider_rejected", data: { reason: "provider_requested_information_without_route_policy" } });
	} else if (result.classification === "rejected") {
		await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "awaiting_provider_reply", to: "provider_rejected" });
	}
	else if (result.classification === "bounce") {
		// A bounce may arrive immediately after SMTP acceptance, before the
		// sender moves the run/route into its normal waiting state. Correlate and
		// settle all three records atomically so a late sender completion cannot
		// restore `awaiting_provider_reply` over the known delivery failure.
		const bounced = await AbuseRepository.settleCorrelatedEmailBounce({ inboundMessageId: message.id });
		if (!bounced.settled) {
			await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "awaiting_provider_reply", to: "provider_rejected", data: { reason: "uncorrelated_provider_bounce" } });
		}
	}
}

export async function monitorProviderReply(routeId: bigint): Promise<void> {
	const route = await AbuseRepository.getRoute(routeId);
	if (!route || route.status !== "awaiting_provider_reply") return;
	// IMAP continuously creates concrete reply-classification jobs. Silence
	// is not a reason to escalate to a portal or change the route state.
	await AbuseRepository.recomputeReportStatus(route.reportId);
}
