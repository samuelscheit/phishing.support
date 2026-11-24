import { classifyProviderReply, extractVerifiedProviderLinks } from "../mail/reply";
import { isRelayRefusal } from "../mail/relay_refusal";
import { isAttachmentRefusal } from "../mail/attachment_policy";
import { getProviderSubmissionProvider, getProviderSubmissionProviderForMailbox } from "../providers";
import { verifiedDomainsForEmailRoute } from "../providers/email";
import { AbuseRepository } from "../repository";
import { fallbackContactsOf, routeContact, withRouteContact } from "../resolver/contact_chain";
import { contactRoute } from "../resolver/routes";
import { deliveryRetryDelayMs } from "./retry";
import type { JsonRecord } from "../../util/values";
import { abuseCaseTag } from "../mail/correlation";
import { deliveryReport } from "../mail/delivery_report";
import { caseReferenceCandidates } from "../../referral/case_reference";
import { queueRelayResend } from "./email";
import { isAuthorityRoute, isPreservationRoute } from "../../referral/routes";
import type { AbuseMailMessage, AbuseProviderRoute } from "../schema";

export async function classifyReply(messageId: bigint): Promise<void> {
	const message = await AbuseRepository.getMailMessage(messageId);
	if (!message) return;
	const route = await AbuseRepository.getRoute(message.routeId);
	if (!route) return;
	if (message.kind === "notification") {
		// A provider status update about a report it received is part of the
		// case record; it never changes the route by itself. Its classification
		// is the decision it states, or receipt.
		const verdict = getProviderSubmissionProvider(route.providerRegistryKey)?.inboundMail?.verdictOf?.(message.textBody ?? "");
		await AbuseRepository.setMailClassification(message.id, verdict ?? "acknowledged", "provider_notification");
		return;
	}
	if (message.kind === "bounce") {
		await settleDeliveryFailure(message, route);
		return;
	}
	if (isAuthorityRoute(route) || isPreservationRoute(route)) {
		await classifyReferralReply(message, route);
		return;
	}
	const result = await classifyProviderReply({ text: message.textBody ?? "", from: message.fromAddress ?? undefined });
	// A mailbox a reviewed provider owns already has its code-owned form route; its
	// "use our form" answer must not start a second filing by the generic browser agent.
	const providerOwnsMailbox = !!route.verifiedEmail && !!getProviderSubmissionProviderForMailbox(route.verifiedEmail);
	const links = result.classification === "not_monitored" && !providerOwnsMailbox
		? await extractVerifiedProviderLinks({
			verifiedDomains: route.verifiedEmail ? verifiedDomainsForEmailRoute(route.verifiedEmail) : undefined,
			text: message.textBody ?? "",
		})
		: [];
	await AbuseRepository.setMailClassification(message.id, result.classification, result.rationale);
	if (result.classification === "acknowledged") {
		await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "awaiting_provider_reply", to: "acknowledged" });
	} else if (result.classification === "not_monitored" && links.length > 0) {
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
	} else if (result.classification === "not_monitored" && providerOwnsMailbox) {
		// The reply is the provider's standard answer to mail; the report stays with it.
	} else if (result.classification === "not_monitored") {
		await AbuseRepository.transitionRouteStatus({
			routeId: route.id,
			from: "awaiting_provider_reply",
			to: "provider_rejected",
			data: { reason: "provider_mailbox_not_monitored_without_verified_form" },
		});
	} else if (result.classification === "needs_more_information") {
		// No immutable route policy can currently determine which provider
		// questions are safely answerable from stored evidence. Finish safely
		// rather than making email text an instruction source.
		await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "awaiting_provider_reply", to: "provider_rejected", data: { reason: "provider_requested_information_without_route_policy" } });
	} else if (result.classification === "rejected") {
		await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "awaiting_provider_reply", to: "provider_rejected" });
	}
}

/**
 * A delivery report for the route's mail, which ingestion recognised by its
 * structure (mail/delivery_report.ts), never by the reply classifier: an
 * autoresponder reads like a bounce to a model but proves the mailbox works.
 */
async function settleDeliveryFailure(message: AbuseMailMessage, route: AbuseProviderRoute): Promise<void> {
	const text = message.textBody ?? "";
	const { outcome, diagnostic } = deliveryReport(text);
	const failureReason = diagnostic ?? "The recipient's mail server rejected the report.";
	if (isRelayRefusal(text)) {
		// Our relay, not the provider, refused the report: its mailbox is not dead, so no
		// other contact is tried. The relay gets one more attempt (queueRelayResend).
		await AbuseRepository.setMailClassification(message.id, "relay_refused", "relay_refusal");
		await settleBounce(message.id, route, { retry: false, reason: "relay_refused", failureReason });
		const settled = await AbuseRepository.getRoute(route.id);
		if (settled?.status === "delivery_failed") await queueRelayResend(settled);
		return;
	}
	if (outcome === "permanent" && isAttachmentRefusal(text)) {
		// The server refused an attached file (the phishing mail, xarf.json), not the mailbox:
		// the report goes once more with those attached as text. A second such refusal is the mailbox's.
		const earlier = (await AbuseRepository.listMailForReport(route.reportId))
			.some((other) => other.routeId === route.id && other.id !== message.id && other.disposition === "attachment_refusal");
		if (!earlier) {
			await AbuseRepository.setMailClassification(message.id, "bounce", "attachment_refusal");
			if (await settleBounce(message.id, route, { retry: false, failureReason }) === "settled") {
				await AbuseRepository.enqueueJobOnce({
					jobType: "send_email",
					reportId: route.reportId,
					routeId: route.id,
					payload: { retryReason: "attachment_refused" },
					dedupeKey: `attachment-resend:${route.id.toString()}`,
				});
			}
			return;
		}
	}
	await AbuseRepository.setMailClassification(message.id, "bounce", "delivery_status_notification");
	// A temporary failure is resent with backoff until its bound; past it, it
	// counts as permanent.
	const sends = (await AbuseRepository.listMailForReport(route.reportId))
		.filter((other) => other.routeId === route.id && other.direction === "outbound")
		.map((send) => send.createdAt);
	const retryAfterMs = outcome === "temporary" ? deliveryRetryDelayMs(sends, new Date()) : undefined;
	const settlement = retryAfterMs !== undefined
		? await settleBounce(message.id, route, { retry: true, retryAfterMs, failureReason })
		: await settleBounce(message.id, route, outcome === "temporary"
			? { retry: false, reason: "delivery_retries_exhausted", failureReason: `${failureReason} (temporary failures over ${sends.length} sends; treated as permanent)` }
			: { retry: false, failureReason });
	// The mailbox will never accept the report; move on to the target's next
	// published abuse contact.
	if (retryAfterMs === undefined && settlement !== "unchanged") await routeToNextContact(route.id);
}

/**
 * A reply to a criminal referral or a preservation notice is read by the
 * operator, never acted on by a provider workflow: it is classified for the
 * record and closes the wait. An authority's reply that names exactly one
 * file number of its own sets the route's case reference; several are kept
 * as candidates for the operator to choose from.
 */
async function classifyReferralReply(message: AbuseMailMessage, route: AbuseProviderRoute): Promise<void> {
	const text = message.textBody ?? "";
	const result = await classifyProviderReply({ text, from: message.fromAddress ?? undefined });
	await AbuseRepository.setMailClassification(message.id, result.classification, result.rationale);
	if (isAuthorityRoute(route)) {
		const candidates = caseReferenceCandidates(`${message.subject ?? ""}\n${text}`, [abuseCaseTag(route.reportId)]);
		await AbuseRepository.appendEvent({
			reportId: route.reportId,
			routeId: route.id,
			eventType: "referral.reply_received",
			data: { messageId: message.id.toString(), classification: result.classification, caseReferenceCandidates: candidates.map((candidate) => candidate.value) },
		});
		if (candidates.length === 1 && !route.caseReference) await AbuseRepository.setCaseReference(route.id, candidates[0]!.value, `reply:${message.id.toString()}`);
		// Any answer from the authority, a transfer to another office included, is a receipt.
		await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "awaiting_provider_reply", to: "acknowledged" });
		return;
	}
	const to = result.classification === "rejected" || result.classification === "not_monitored" ? "provider_rejected" : result.classification === "acknowledged" ? "acknowledged" : undefined;
	if (to) await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "awaiting_provider_reply", to });
}

/**
 * A bounce may arrive immediately after SMTP acceptance, before the sender
 * moves the run/route into its normal waiting state. Correlate and settle all
 * three records atomically so a late sender completion cannot restore
 * `awaiting_provider_reply` over the known delivery failure.
 *
 * `settled`: the bounced send failed. `uncorrelated`: the bounce names no
 * send of the route, which it ends instead. `unchanged`: nothing changed,
 * above all for a notice about a send that already failed (a second notice
 * for it, or its classification replayed after a worker restart) while the
 * route has moved on to a resend.
 */
async function settleBounce(messageId: bigint, route: { id: bigint }, options: { retry: boolean; retryAfterMs?: number; failureReason: string; reason?: "relay_refused" | "delivery_retries_exhausted" }): Promise<"settled" | "uncorrelated" | "unchanged"> {
	const bounced = await AbuseRepository.settleCorrelatedEmailBounce({ inboundMessageId: messageId, ...options });
	if (bounced.settled) return "settled";
	if (bounced.stale) return "unchanged";
	// A refusal by our own relay is no answer of the provider's, correlated or not.
	const relay = options.reason === "relay_refused";
	const ended = await AbuseRepository.transitionRouteStatus({
		routeId: route.id,
		from: "awaiting_provider_reply",
		to: relay ? "delivery_failed" : "provider_rejected",
		data: { reason: relay ? "uncorrelated_relay_refusal" : "uncorrelated_provider_bounce" },
	});
	return ended ? "uncorrelated" : "unchanged";
}

/**
 * Report to the next published abuse contact after a mailbox permanently
 * rejected the report: the first of `contacts` (by default the bounced
 * route's own fallbacks) without a route on this target yet. The new route is
 * found the way the bounced one was, carries the remaining contacts, and
 * records every mailbox that failed before it (`bouncedEmails`), so a chain
 * of dead mailboxes is walked one bounce at a time and an upstream's mail can
 * name them.
 */
export async function routeToNextContact(bouncedRouteId: bigint, contacts?: readonly JsonRecord[]): Promise<bigint | undefined> {
	const bounced = await AbuseRepository.getRoute(bouncedRouteId);
	if (!bounced || bounced.routeType !== "email") return undefined;
	const existing = new Set((await AbuseRepository.listRoutes(bounced.reportId))
		.filter((route) => route.targetId === bounced.targetId)
		.map((route) => route.verifiedEmail?.toLowerCase())
		.filter(Boolean));
	const remaining = fallbackContactsOf({ fallbackContacts: contacts ?? bounced.resolverProvenance.fallbackContacts })
		.filter((contact, index, all) => !existing.has(contact.email.toLowerCase()) && all.findIndex((other) => other.email.toLowerCase() === contact.email.toLowerCase()) === index);
	const [next, ...rest] = remaining;
	if (!next) return undefined;
	const earlier = routeContact(bounced.resolverProvenance).bouncedEmails;
	const bouncedEmails = [...new Set([...(Array.isArray(earlier) ? earlier.filter((email) => typeof email === "string") : []), ...(bounced.verifiedEmail ? [bounced.verifiedEmail] : [])])];
	const target = await AbuseRepository.getTarget(bounced.targetId);
	const routeInput = contactRoute({
		email: next.email,
		providerName: (typeof next.organization === "string" ? next.organization : undefined)
			?? (typeof next.entityName === "string" ? next.entityName : undefined)
			?? `Abuse contact for ${target?.normalizedTarget ?? "the target"}`,
		provenance: withRouteContact(
			bounced.resolverProvenance,
			{ ...next, reason: "fallback_after_permanent_bounce", bouncedRouteId: bounced.id.toString(), bouncedEmails },
			rest,
		),
		snapshot: bounced.resolutionSnapshot,
	});
	const route = await AbuseRepository.upsertResolvedRoute(bounced.targetId, routeInput);
	if (route.status !== "verified") return route.id;
	await AbuseRepository.enqueueJob({
		jobType: route.routeType === "provider_submission" ? "submit_provider" : "send_email",
		reportId: route.reportId,
		routeId: route.id,
		payload: {},
		dedupeKey: route.routeType === "provider_submission" ? `provider-submit:${route.id.toString()}` : `email:${route.id.toString()}`,
	});
	await AbuseRepository.recomputeReportStatus(route.reportId);
	return route.id;
}

/** The route the report moved on to after `bounced`'s mailbox failed, if any. */
export async function nextContactRoute(bounced: Pick<AbuseProviderRoute, "id" | "reportId">): Promise<AbuseProviderRoute | undefined> {
	return (await AbuseRepository.listRoutes(bounced.reportId)).find((route) => routeContact(route.resolverProvenance).bouncedRouteId === bounced.id.toString());
}

export async function monitorProviderReply(routeId: bigint): Promise<void> {
	const route = await AbuseRepository.getRoute(routeId);
	if (!route || route.status !== "awaiting_provider_reply") return;
	// IMAP continuously creates concrete reply-classification jobs. Silence
	// is not a reason to escalate to a portal or change the route state.
	await AbuseRepository.recomputeReportStatus(route.reportId);
}
