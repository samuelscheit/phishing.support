import { deliveryReport } from "../mail/delivery_report";
import { AbuseRepository } from "../repository";
import { resolveIpTarget } from "../resolver/ip";
import { fallbackContactsOf } from "../resolver/contact_chain";
import type { ResolverDependencies } from "../resolver/types";
import { asRecord, text } from "../../util/values";
import { nextContactRoute, routeToNextContact } from "./mail";

export type IpFallbackRepair = {
	routeId: string;
	verifiedEmail: string | null;
	/** `routed`: the report moved on to `nextContact`; `skipped`: left as it was, for `reason`. */
	result: "routed" | "skipped";
	reason?: "not_ip_derived" | "not_permanently_failed" | "already_routed_on" | "no_other_contact";
	/** The address re-resolved for the route's contacts. */
	ip?: string;
	nextContact?: string;
};

/**
 * One-off repair, idempotent: mail routes found through an IP address whose
 * mailbox failed for good (a permanent bounce, or temporary failures past
 * their bound) while the report had nowhere to go next. Until IP resolution
 * recorded fallback contacts, such a route carried none
 * (ip.abuse@tatatel.co.in for 14.194.139.244, 2026-11-20).
 *
 * The address is resolved again and every contact it publishes now (the
 * allocation's, its parent objects', the origin ASN's, the upstream
 * transit's) is offered after the route's own fallbacks; the first that has
 * no route on the target yet gets the report. A route that already moved on
 * is skipped, so a rerun changes nothing. Run after `repairMisreadBounces()`,
 * which first turns the tatatel route into a `delivery_failed` one:
 * `bun -e 'import { repairIpRoutesWithoutFallback } from "./src/lib/abuse/worker/ip_fallback_repair"; console.log(await repairIpRoutesWithoutFallback())'`
 */
export async function repairIpRoutesWithoutFallback(dependencies: ResolverDependencies = {}): Promise<IpFallbackRepair[]> {
	const repairs: IpFallbackRepair[] = [];
	const failed = await AbuseRepository.listEmailRoutesByLastStatusChange("delivery_failed", ["provider_bounce", "delivery_retries_exhausted"]);
	for (const route of failed) {
		const outcome = { routeId: route.id.toString(), verifiedEmail: route.verifiedEmail };
		const target = await AbuseRepository.getTarget(route.targetId);
		const ip = target?.targetType === "ip"
			? target.normalizedTarget
			: route.resolverProvenance.source === "domain_infrastructure_ip" ? text(route.resolverProvenance.originatingIp) : undefined;
		if (!ip) {
			repairs.push({ ...outcome, result: "skipped", reason: "not_ip_derived" });
			continue;
		}
		if (!await failedForGood(route)) {
			repairs.push({ ...outcome, ip, result: "skipped", reason: "not_permanently_failed" });
			continue;
		}
		const existing = await nextContactRoute(route);
		if (existing) {
			repairs.push({ ...outcome, ip, result: "skipped", reason: "already_routed_on", ...(existing.verifiedEmail ? { nextContact: existing.verifiedEmail } : {}) });
			continue;
		}
		const resolved = (await resolveIpTarget({ normalizedTarget: ip, targetType: "ip", observedUrls: [] }, dependencies)).routes[0];
		const chain = resolved?.verifiedEmail ? [contactOf(resolved.resolverProvenance), ...fallbackContactsOf(resolved.resolverProvenance)] : [];
		const nextRouteId = await routeToNextContact(route.id, [...fallbackContactsOf(route.resolverProvenance), ...chain]);
		const next = nextRouteId ? await AbuseRepository.getRoute(nextRouteId) : undefined;
		repairs.push(next
			? { ...outcome, ip, result: "routed", ...(next.verifiedEmail ? { nextContact: next.verifiedEmail } : {}) }
			: { ...outcome, ip, result: "skipped", reason: "no_other_contact" });
	}
	return repairs;
}

/** A resolved route's own contact, without the fallbacks it carries. */
function contactOf(provenance: Record<string, unknown>): Record<string, unknown> {
	const { fallbackContacts: _fallbacks, ...contact } = asRecord(provenance) ?? {};
	return contact;
}

/** True when the route's last delivery report failed it permanently, or it ran out of temporary retries. */
async function failedForGood(route: { id: bigint; reportId: bigint }): Promise<boolean> {
	const events = await AbuseRepository.listEvents(route.reportId);
	const change = events.filter((event) => event.routeId === route.id && event.eventType === "route.status_changed").at(-1);
	if (asRecord(change?.data)?.reason === "delivery_retries_exhausted") return true;
	const lastBounce = (await AbuseRepository.listMailForReport(route.reportId))
		.filter((message) => message.routeId === route.id && message.direction === "inbound" && message.kind === "bounce")
		.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
		.at(-1);
	return !!lastBounce && deliveryReport(lastBounce.textBody ?? "").outcome === "permanent";
}
