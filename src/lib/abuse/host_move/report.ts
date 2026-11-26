import { HOST_MOVE_ACTION_EVENT, hostMovesOf, type HostMove } from "../../liveness/moves";
import { getReportsByIds, type SubmissionReportRoute } from "../../submissions/abuse_details";
import { decisionOf } from "../../submissions/report_view";
import { sha256Hex } from "../../util/hash";
import { asRecord } from "../../util/values";
import { sendRouteNotice, type NoticeOutcome } from "../followup/route_notice";
import { abuseEmailCaseUrl } from "../mail/draft";
import { recipientGreeting } from "../mail/shared";
import type { sendAbuseEmailRoute } from "../mail/send";
import { getProviderSubmissionProvider } from "../providers";
import { readOriginHostSnapshot } from "../origin/snapshot";
import { AbuseRepository } from "../repository";
import { resolveIpTarget } from "../resolver/ip";
import { fallbackContactsOf, routeContact } from "../resolver/contact_chain";
import { attachInfrastructureRoute } from "../resolver/domain_infrastructure";
import type { ResolverDependencies } from "../resolver/types";
import type { AbuseProviderRoute, AbuseTarget } from "../schema";
import { queueCorrespondencePoll, queueRouteDelivery } from "../worker/schedule";
import { cdnBypassNotice, hostMoveEvidence, hostMoveNotice, registrarMoveNotice, type MoveNoticeParams } from "./notice";

const MOVE_EVIDENCE_KIND = "host_move_evidence";
/** Messages written to a provider after its report: an operator's follow-up (scripts/route_follow_up.ts) or an answer to its decision. */
const FOLLOW_UP_KEY = /^(?:follow-up|decision-follow-up):/;

export type HostMoveReportDependencies = {
	resolveIp?: typeof resolveIpTarget;
	resolver?: ResolverDependencies;
	send?: typeof sendAbuseEmailRoute;
	providerFor?: typeof getProviderSubmissionProvider;
};

/** Routes that never reached the provider and cannot be followed up on. */
const UNSENT = new Set(["awaiting_approval", "discarded", "resolving", "no_route", "failed", "needs_human", "insufficient_evidence"]);

/** Every AS a route's resolution attributed to the host it reaches: the address it was resolved through, or the networks Cloudflare's disclosure was validated against. */
function routeAsns(route: AbuseProviderRoute): number[] {
	const snapshot = asRecord(route.resolutionSnapshot) ?? {};
	const resolutions = [snapshot, ...(Array.isArray(snapshot.sourceSnapshots) ? snapshot.sourceSnapshots.map(asRecord) : [])];
	const fromAddress = resolutions.flatMap((entry) => {
		const asns = asRecord(asRecord(asRecord(entry)?.ipResolution)?.bgpOrigin)?.asns;
		return Array.isArray(asns) ? asns.map(Number) : [];
	});
	const origin = readOriginHostSnapshot(route.resolutionSnapshot);
	return [...new Set([...fromAddress, ...(origin?.networks.map(({ asn }) => asn) ?? []), ...(origin?.servers.flatMap(({ asn }) => (asn === undefined ? [] : [asn])) ?? [])])]
		.filter((asn) => Number.isSafeInteger(asn) && asn > 0);
}

/** Every mailbox a resolution names for an address, its first contact and its fallbacks. */
function contactMailboxes(routes: ReadonlyArray<{ verifiedEmail?: string | null; resolverProvenance: Record<string, unknown> }>): string[] {
	return [...new Set(routes.flatMap((route) => [
		...(route.verifiedEmail ? [route.verifiedEmail] : []),
		...fallbackContactsOf(routeContact(route.resolverProvenance)).map(({ email }) => email),
	]).map((email) => email.toLowerCase()))];
}

/**
 * Act once on a move a liveness check found, while the site still serves
 * what was reported at its new hosting:
 *
 * 1. The new host. A route of the report already reaching it (the same
 *    abuse mailbox, or a network its resolution named) gets a follow-up on
 *    that route with the new proof; otherwise the address's abuse contact,
 *    resolved as any hosting address is, becomes a new route of the same
 *    report and is delivered through its normal channel.
 * 2. The CDN the site left, when it had acted on it: through the follow-up
 *    channel its provider names (Cloudflare's abusereply@cloudflare.com).
 * 3. The registrar, when it has not acted: its correspondence is read again
 *    where its provider offers that, and the move is sent where it takes
 *    more evidence.
 *
 * Each step records what it did as a `site.host_move_action` event, and
 * each message goes out under a correlation key of the move and route, so a
 * retried job sends nothing twice.
 */
export async function reportHostMove(params: { reportId: bigint; key: string }, dependencies: HostMoveReportDependencies = {}): Promise<void> {
	const events = await AbuseRepository.listEvents(params.reportId);
	const move = hostMovesOf(events).find((candidate) => candidate.key === params.key);
	if (move?.content !== "served") return;
	const targetId = BigInt(move.targetId);
	const [target, report, routes, [view], mail, input] = await Promise.all([
		AbuseRepository.getTarget(targetId),
		AbuseRepository.getReport(params.reportId),
		AbuseRepository.listRoutes(params.reportId),
		getReportsByIds([params.reportId]),
		AbuseRepository.listMailForReport(params.reportId),
		AbuseRepository.getReportInput(params.reportId),
	]);
	if (!target || !report || !view) return;
	// The screenshots the report went with: forms that take more evidence require one (Eranet's supplement form).
	const screenshots = (input?.evidenceArtifacts ?? [])
		.filter((artifact) => artifact.mimeType.startsWith("image/"))
		.slice(0, 2)
		.map((artifact) => ({ filename: artifact.name, mimeType: artifact.mimeType, content: Buffer.from(artifact.blob) }));
	const mailKeys = new Map(mail.map((message) => [message.id, message.correlationKey]));
	const domain = target.normalizedTarget;
	const caseUrl = abuseEmailCaseUrl(report.submissionId);
	const base = { move, domain, allegation: report.allegationCategory, ...(caseUrl ? { caseUrl } : {}) };
	const providerFor = dependencies.providerFor ?? getProviderSubmissionProvider;
	const views = new Map(view.routes.map((route) => [route.id, route]));
	const live = routes.filter((route) => route.targetId === targetId && route.routeType !== "manual_unroutable" && !UNSENT.has(route.status));
	const correlationKey = (route: AbuseProviderRoute) => `host-move:${sha256Hex(move.key).slice(0, 16)}:${route.id.toString()}`;
	const record = (route: AbuseProviderRoute | undefined, data: Record<string, unknown>) => AbuseRepository.appendEvent({
		reportId: params.reportId,
		targetId,
		...(route ? { routeId: route.id } : {}),
		eventType: HOST_MOVE_ACTION_EVENT,
		data: { key: move.key, ...data },
	});
	const notify = async (route: AbuseProviderRoute, role: string, body: (greeting: string) => string): Promise<NoticeOutcome | { status: "already_told" }> => {
		const routeView = views.get(route.id);
		// Someone already wrote to the provider since the site moved (an operator's follow-up, an answer to its decision): that told it.
		if (routeView?.messages.some((message) => message.direction === "outbound" && !message.moveNotice && message.status !== "failed" && message.occurredAt.getTime() > new Date(move.since).getTime() && FOLLOW_UP_KEY.test(mailKeys.get(message.id) ?? ""))) {
			if (!(await recorded(params.reportId, move.key, "already_told", route.id))) await record(route, { role, action: "already_told" });
			return { status: "already_told" };
		}
		const addressee = providerFor(route.providerRegistryKey)?.decisionFollowUp?.addressee;
		const greeting = addressee ? `Hello ${addressee} Trust & Safety,` : recipientGreeting(routeView?.organisation ?? route.providerDisplayName);
		const outcome = await sendRouteNotice(route, { body: body(greeting), attachments: screenshots, correlationKey: correlationKey(route) }, { ...(dependencies.send ? { send: dependencies.send } : {}), providerFor });
		if (outcome.status === "sent") await record(route, { role, action: "followed_up", to: outcome.to });
		else if (outcome.status === "no_channel" && !(await recorded(params.reportId, move.key, "no_channel", route.id))) await record(route, { role, action: "no_channel" });
		return outcome;
	};

	const hostContact = await reportNewHost({ move, target, live, base, notify, record, dependencies });

	// The CDN the site left, when it had acted on the site before it left.
	for (const route of live) {
		const routeView = views.get(route.id);
		if (!move.from.cdn || routeView?.role !== "cdn" || !(routeView.organisation === move.from.cdn || (move.from.asn !== undefined && routeAsns(route).includes(move.from.asn)))) continue;
		const decided = decisionOf(routeView.messages);
		if (decided?.decision.outcome !== "action_taken" || decided.at.getTime() > new Date(move.at).getTime()) continue;
		const confirmationId = routeView.confirmationId ?? route.id.toString();
		await notify(route, "cdn", (greeting) => cdnBypassNotice({ ...base, greeting, confirmationId, ...(hostContact ? { hostContact } : {}) }));
	}

	// The registrar, when it has not acted: read what it did, and tell it where it takes more.
	for (const route of live) {
		const routeView = views.get(route.id);
		if (routeView?.role !== "registrar" || decisionOf(routeView.messages)?.decision.outcome === "action_taken") continue;
		if (route.status === "submitted" && providerFor(route.providerRegistryKey)?.fetchCorrespondence) {
			await queueCorrespondencePoll(route);
			if (!(await recorded(params.reportId, move.key, "rechecked", route.id))) await record(route, { role: "registrar", action: "rechecked" });
		}
		await notify(route, "registrar", (greeting) => registrarMoveNotice({ ...base, greeting }));
	}
}

/**
 * Tell the move's new host: a follow-up on a route that already reaches it,
 * or a new route to the abuse contact of its address. Returns the mailbox or
 * channel the host was told through, when it was.
 */
async function reportNewHost(params: {
	move: HostMove;
	target: AbuseTarget;
	live: readonly AbuseProviderRoute[];
	base: Omit<MoveNoticeParams, "greeting">;
	notify: (route: AbuseProviderRoute, role: string, body: (greeting: string) => string) => Promise<NoticeOutcome | { status: "already_told" }>;
	record: (route: AbuseProviderRoute | undefined, data: Record<string, unknown>) => Promise<void>;
	dependencies: HostMoveReportDependencies;
}): Promise<string | undefined> {
	const { move, target, live, base, notify, record, dependencies } = params;
	const ip = move.to.addresses[0];
	if (!ip) return undefined;
	const resolved = await (dependencies.resolveIp ?? resolveIpTarget)({ normalizedTarget: ip, targetType: "ip", observedUrls: target.observedUrls }, dependencies.resolver ?? {});
	const contacts = resolved.routes.filter((route) => route.routeType !== "manual_unroutable");
	const mailboxes = contactMailboxes(contacts);
	// A route this move created (a retried job) is the new report itself, not one to follow up on.
	const covering = live.find((route) => asRecord(asRecord(route.resolverProvenance.dnsResolution))?.moveKey !== move.key
		&& ((route.verifiedEmail && mailboxes.includes(route.verifiedEmail.toLowerCase())) || (move.to.asn !== undefined && routeAsns(route).includes(move.to.asn))));
	if (covering) {
		const outcome = await notify(covering, "host", (greeting) => hostMoveNotice({ ...base, greeting }));
		return outcome.status === "sent" ? covering.verifiedEmail ?? outcome.to : outcome.status === "no_channel" ? undefined : covering.verifiedEmail ?? covering.providerDisplayName;
	}
	const [contact] = contacts;
	if (!contact) {
		if (!(await recorded(target.reportId, move.key, "no_contact"))) await record(undefined, { role: "host", action: "no_contact", ip, ...(resolved.disposition ? { reason: resolved.disposition } : {}) });
		return undefined;
	}
	const input = attachInfrastructureRoute({
		domain: target.normalizedTarget,
		ip,
		dnsSnapshot: { source: "host_move", moveKey: move.key, observedAt: move.at, publicAddresses: move.to.addresses },
		route: contact,
	});
	const route = await AbuseRepository.upsertResolvedRoute(target.id, input);
	// Named by the move, so a retried job finds its own file and a later move adds its own.
	await AbuseRepository.saveRouteArtifactOnce({
		reportId: target.reportId,
		routeId: route.id,
		name: `hosting-change-${sha256Hex(move.key).slice(0, 8)}.txt`,
		kind: MOVE_EVIDENCE_KIND,
		mimeType: "text/plain",
		buffer: hostMoveEvidence(move, target.normalizedTarget),
		metadata: { moveKey: move.key },
	});
	await queueRouteDelivery(route);
	await AbuseRepository.recomputeReportStatus(target.reportId);
	if (!(await recorded(target.reportId, move.key, "reported", route.id))) await record(route, { role: "host", action: "reported", to: route.verifiedEmail ?? route.providerDisplayName });
	return route.verifiedEmail ?? route.providerDisplayName;
}

/** Whether the move's action is on record already, for the route when one is named. */
async function recorded(reportId: bigint, key: string, action: string, routeId?: bigint): Promise<boolean> {
	return (await AbuseRepository.listEvents(reportId)).some((event) => event.eventType === HOST_MOVE_ACTION_EVENT
		&& (routeId === undefined || event.routeId === routeId)
		&& asRecord(event.data)?.key === key
		&& asRecord(event.data)?.action === action);
}
