import { verifyReportedContent, stillAbusive, type ContentVerification, type ContentVerificationDependencies } from "../../liveness/content";
import { hostMovesOf } from "../../liveness/moves";
import { listSiteChecksForTargets } from "../../liveness/repository";
import { registeredCountry } from "../../network/ripestat";
import { getReportsByIds, type SubmissionReportRoute } from "../../submissions/abuse_details";
import { decisionOf } from "../../submissions/report_view";
import { DAY_MS } from "../../util/date_time";
import { asRecord } from "../../util/values";
import { draftMailRoute } from "../approval/drafted_mail";
import { sendRouteNotice } from "../followup/route_notice";
import { abuseEmailCaseUrl } from "../mail/draft";
import { recipientGreeting } from "../mail/shared";
import type { sendAbuseEmailRoute } from "../mail/send";
import { getProviderSubmissionProvider } from "../providers";
import { AbuseRepository } from "../repository";
import { routeContact } from "../resolver/contact_chain";
import type { AbuseEvent, AbuseProviderRoute, AbuseTarget } from "../schema";
import { routeToContact } from "../worker/mail";
import { UnknownExternalStateError } from "../worker/shared";
import { brandDraft, certDraft, dsaNoticeDraft, followUpNotice, icannComplaintText, type Draft, type EscalationFacts, type UnactedProvider } from "./notice";
import { escalationPlan, stepKey, type EscalationRoute, type EscalationStep } from "./policy";
import { brandRecipient, DSA_COUNTRIES, ICANN_COMPLAINT, isGenericTld, NATIONAL_CERTS } from "./recipients";

/** One step of the ladder taken for a route or the site, with what it did. */
export const ESCALATION_EVENT = "route.escalated";
/** The ladder waited: the site no longer serves the reported content, or that could not be confirmed. */
export const ESCALATION_HELD_EVENT = "escalation.held";
/** A site whose content could not be confirmed is looked at again this much later. */
const UNVERIFIED_RETRY_MS = DAY_MS;
/** A site whose page changed into something the classifier finds harmless is looked at again this much later. */
const NOT_MALICIOUS_RETRY_MS = 7 * DAY_MS;
/** Answers that say the report never reached anyone: such a route has nothing to escalate from. */
const UNDELIVERED = new Set(["bounced", "not_delivered", "pending"]);

export const escalationJobKey = (targetId: bigint) => `escalation:${targetId.toString()}`;

export type EscalationDependencies = {
	verify?: ContentVerificationDependencies;
	send?: typeof sendAbuseEmailRoute;
	providerFor?: typeof getProviderSubmissionProvider;
	/** The country a network's AS is registered in; production asks RIPEstat. */
	countryOf?: (asn: number) => Promise<string | undefined>;
	now?: () => Date;
};

type RouteState = { route: AbuseProviderRoute; view: SubmissionReportRoute; ladder: EscalationRoute };

/** The target's routes as the ladder reads them, and the steps already taken. */
async function escalationState(reportId: bigint, targetId: bigint) {
	const [routes, [view], events] = await Promise.all([AbuseRepository.listRoutes(reportId), getReportsByIds([reportId]), AbuseRepository.listEvents(reportId)]);
	const views = new Map((view?.routes ?? []).map((route) => [route.id, route]));
	const states: RouteState[] = routes.filter((route) => route.targetId === targetId && views.has(route.id)).map((route) => {
		const routeView = views.get(route.id)!;
		const decision = decisionOf(routeView.messages)?.decision.outcome;
		return {
			route,
			view: routeView,
			ladder: {
				routeId: route.id,
				role: routeView.role,
				...(routeView.outcome.sentAt && !UNDELIVERED.has(routeView.outcome.verdict) ? { sentAt: routeView.outcome.sentAt } : {}),
				...(decision ? { decision } : {}),
				escalated: asRecord(routeContact(route.resolverProvenance).escalation) !== undefined,
			},
		};
	});
	const taken = new Set(events.filter((event) => event.eventType === ESCALATION_EVENT && event.targetId === targetId).flatMap((event) => {
		const level = Number(asRecord(event.data)?.level);
		return Number.isInteger(level) ? [stepKey({ level, ...(event.routeId === null ? {} : { routeId: event.routeId }) })] : [];
	}));
	// The site left the hosting it was reported on: the host-move report tells the new host, and the old one is not escalated to.
	const moved = hostMovesOf(events).some((move) => move.targetId === targetId.toString());
	return { states, taken, events, moved };
}

/**
 * When the ladder may look at the site again after it held: a day after
 * content that could not be confirmed, a week after a page the classifier
 * found harmless. A site taken down is not checked by liveness for
 * escalation at all until it is back up.
 */
function heldUntil(events: readonly AbuseEvent[], targetId: bigint): Date | undefined {
	const held = events.findLast((event) => event.eventType === ESCALATION_HELD_EVENT && event.targetId === targetId);
	if (!held) return undefined;
	const data = asRecord(held.data);
	const at = typeof data?.at === "string" ? new Date(data.at) : held.createdAt;
	return new Date(at.getTime() + (data?.verdict === "not_malicious" ? NOT_MALICIOUS_RETRY_MS : UNVERIFIED_RETRY_MS));
}

/**
 * Queue the target's escalation job for when its next step falls due (now
 * when one already is), or nothing once the ladder is done. One job per
 * target; a later call moves it earlier, never later. A running escalation
 * job passes itself as `successorOf` to queue the next.
 */
export async function scheduleEscalation(target: { reportId: bigint; targetId: bigint }, now = new Date(), successorOf?: bigint): Promise<void> {
	const { states, taken, events } = await escalationState(target.reportId, target.targetId);
	const plan = escalationPlan(states.map((state) => state.ladder), taken, now);
	const due = plan.due.length ? now : plan.nextAt;
	if (!due) return;
	const held = heldUntil(events, target.targetId);
	await queueEscalation(target, held && held > due ? held : due, successorOf);
}

const queueEscalation = (target: { reportId: bigint; targetId: bigint }, at: Date, successorOf: bigint | undefined) => AbuseRepository.enqueueJob({
	jobType: "escalate_target",
	reportId: target.reportId,
	payload: { targetId: target.targetId.toString() },
	dedupeKey: escalationJobKey(target.targetId),
	nextAttemptAt: at,
	advance: true,
	...(successorOf === undefined ? {} : { successorOf }),
});

function firstSentAt(states: readonly RouteState[]): Date | undefined {
	const sent = states.flatMap((state) => (state.ladder.sentAt ? [state.ladder.sentAt.getTime()] : []));
	return sent.length ? new Date(Math.min(...sent)) : undefined;
}

/** The site's hosting address and network from its latest check, unless a CDN fronts it. */
async function hostingOf(targetId: bigint): Promise<{ text: string; asn?: number } | undefined> {
	const latest = (await listSiteChecksForTargets([targetId])).at(-1);
	const address = latest?.hosting?.addresses.find((candidate) => !candidate.cdn) ?? latest?.hosting?.addresses[0];
	if (!address) return undefined;
	const network = address.asn !== undefined ? ` (AS${address.asn}${address.holder ? ` ${address.holder}` : ""})` : "";
	return { text: `${address.ip}${network}${address.cdn ? `, behind ${address.cdn}` : ""}`, ...(address.asn !== undefined && !address.cdn ? { asn: address.asn } : {}) };
}

function unacted(state: RouteState): UnactedProvider {
	return {
		role: state.view.role,
		name: state.view.organisation,
		...(state.route.verifiedEmail ? { email: state.route.verifiedEmail } : {}),
		reportedAt: state.ladder.sentAt!,
		...(state.view.confirmationId ? { reference: state.view.confirmationId } : {}),
		...(state.ladder.decision === "declined" || state.ladder.decision === "no_threat" ? { answer: state.ladder.decision } : {}),
	};
}

/** The routes an escalation still speaks of: takedown providers reached that did not act, not the hosting the site has left. */
function climbing(context: Pick<StepContext, "states" | "moved">): RouteState[] {
	return context.states.filter((state) => ["host", "registrar", "cdn"].includes(state.ladder.role)
		&& state.ladder.sentAt
		&& state.ladder.decision !== "action_taken"
		&& !(context.moved && state.ladder.role !== "registrar"));
}

/** The route a ladder step already created from `from`, when a crash kept the step from being recorded. */
function createdBy(from: bigint, level: number, routes: readonly AbuseProviderRoute[]): AbuseProviderRoute | undefined {
	return routes.find((route) => {
		const escalation = asRecord(routeContact(route.resolverProvenance).escalation);
		return escalation?.fromRouteId === from.toString() && Number(escalation.level) === level;
	});
}

type StepContext = {
	target: AbuseTarget;
	states: RouteState[];
	moved: boolean;
	facts: EscalationFacts;
	hosting?: { text: string; asn?: number };
	dependencies: EscalationDependencies;
};

/** The ladder's own steps; each returns what it did, which its event records. */
async function takeStep(step: EscalationStep, context: StepContext): Promise<Record<string, unknown>> {
	const state = step.routeId === undefined ? undefined : context.states.find((candidate) => candidate.route.id === step.routeId);
	if (state && context.moved && state.ladder.role !== "registrar") return { action: "site_moved" };
	switch (step.step) {
		case "follow_up": {
			const { route, view } = state!;
			const addressee = (context.dependencies.providerFor ?? getProviderSubmissionProvider)(route.providerRegistryKey)?.decisionFollowUp?.addressee;
			const body = followUpNotice({ greeting: addressee ? `Hello ${addressee} Trust & Safety,` : recipientGreeting(view.organisation), facts: context.facts, ...(view.confirmationId ? { reference: view.confirmationId } : {}) });
			const outcome = await sendRouteNotice(route, { body, attachments: [], correlationKey: `escalation:${route.id.toString()}:${step.level}` }, {
				...(context.dependencies.send ? { send: context.dependencies.send } : {}),
				...(context.dependencies.providerFor ? { providerFor: context.dependencies.providerFor } : {}),
			});
			return outcome.status === "sent" ? { action: "followed_up", to: outcome.to } : { action: outcome.status };
		}
		case "next_contact":
		case "upstream": {
			const { route } = state!;
			const upstream = step.step === "upstream";
			const earlier = createdBy(route.id, step.level, await AbuseRepository.listRoutes(route.reportId));
			if (earlier) return { action: "reported", routeId: earlier.id.toString(), to: earlier.verifiedEmail };
			const created = await routeToContact(route.id, {
				choose: (contact) => Boolean(contact.transit) === upstream,
				why: (from) => ({
					reason: "escalation_no_action",
					escalation: {
						level: step.level,
						fromRouteId: from.id.toString(),
						fromProvider: state!.view.organisation,
						...(from.verifiedEmail ? { fromEmail: from.verifiedEmail } : {}),
						reportedAt: state!.ladder.sentAt!.toISOString(),
						verifiedAt: context.facts.verification.checkedAt,
					},
				}),
			});
			const next = created === undefined ? undefined : await AbuseRepository.getRoute(created);
			return next ? { action: "reported", routeId: next.id.toString(), to: next.verifiedEmail } : { action: "no_contact" };
		}
		case "oversight":
			return oversight(context);
		case "exhausted":
			return { action: "needs_human" };
	}
}

/** Draft the mails to the bodies above the providers, for the operator's approval, and prepare the ICANN complaint. */
async function oversight(context: StepContext): Promise<Record<string, unknown>> {
	const { target, facts, dependencies } = context;
	const unanswered = climbing(context);
	const providers = unanswered.map(unacted);
	const country = context.hosting?.asn !== undefined ? await (dependencies.countryOf ?? ((asn: number) => registeredCountry(`AS${asn}`)))(context.hosting.asn).catch(() => undefined) : undefined;
	const drafts: Array<{ kind: string; to: string; draft: Draft; label: string }> = [];
	const cert = country ? NATIONAL_CERTS[country] : undefined;
	if (cert && country) drafts.push({ kind: "cert", to: cert.email, label: cert.name, draft: certDraft({ cert, country, facts, unacted: providers }) });
	if (country && DSA_COUNTRIES.has(country)) {
		for (const state of unanswered.filter((candidate) => candidate.ladder.role === "host" && candidate.route.verifiedEmail)) {
			drafts.push({ kind: "dsa_notice", to: state.route.verifiedEmail!, label: state.view.organisation, draft: dsaNoticeDraft({ host: unacted(state), facts }) });
		}
	}
	const brand = brandRecipient((await AbuseRepository.getReport(target.reportId))?.legalBrandUrl);
	if (brand) drafts.push({ kind: "brand", to: brand.email, label: brand.name, draft: brandDraft({ brand, facts, unacted: providers }) });

	const drafted = [];
	for (const { kind, to, label, draft } of drafts) {
		const route = await draftMailRoute({
			targetId: target.id,
			routeKey: `escalation:${kind}:${to.toLowerCase()}`,
			registryKey: `escalation:${kind}`,
			recipient: to,
			recipientLabel: label,
			draft,
			provenance: { source: "escalation_oversight", kind },
			snapshot: { escalationKind: kind },
		});
		drafted.push({ kind, to, routeId: route.id.toString() });
	}
	const registrar = target.targetType === "domain" && isGenericTld(target.normalizedTarget) ? unanswered.find((state) => state.ladder.role === "registrar") : undefined;
	const manual = registrar ? [{ kind: "icann_complaint", formUrl: ICANN_COMPLAINT.formUrl, registrar: registrar.view.organisation, text: icannComplaintText({ registrar: unacted(registrar), facts }) }] : [];
	return { action: drafted.length || manual.length ? "drafted" : "no_recipient", ...(country ? { country } : {}), drafts: drafted, manual };
}

function verificationSummary(verification: ContentVerification) {
	return { verdict: verification.verdict, tier: verification.tier, checkedAt: verification.checkedAt };
}

/**
 * Take the target's escalation steps that are due, once its site is
 * confirmed to still serve what was reported (`verifyReportedContent`).
 * A site that no longer does holds the ladder; one whose content could not
 * be confirmed is looked at again a day later, within a month of the first
 * report. Every step is recorded as a `route.escalated` event, which also
 * keeps it from being taken twice; then the next step is scheduled.
 */
export async function runEscalation(params: { targetId: bigint; jobId?: bigint; signal?: AbortSignal }, dependencies: EscalationDependencies = {}): Promise<void> {
	const now = (dependencies.now ?? (() => new Date()))();
	const target = await AbuseRepository.getTarget(params.targetId);
	const report = target ? await AbuseRepository.getReport(target.reportId) : undefined;
	const url = target?.observedUrls[0];
	if (!target || !report || report.status === "canceled" || !url) return;
	const { states, taken, moved } = await escalationState(report.id, target.id);
	const plan = escalationPlan(states.map((state) => state.ladder), taken, now);
	const owner = { reportId: report.id, targetId: target.id };
	if (!plan.due.length) {
		await scheduleEscalation(owner, now, params.jobId);
		return;
	}

	const verification = await verifyReportedContent({ reportId: report.id, targetId: target.id, url }, params.signal ? { signal: params.signal } : {}, dependencies.verify ?? {});
	if (!stillAbusive(verification)) {
		await AbuseRepository.appendEvent({ reportId: report.id, targetId: target.id, eventType: ESCALATION_HELD_EVENT, data: { at: now.toISOString(), ...verificationSummary(verification), due: plan.due.map((step) => step.step) } });
		// Looked at again after the hold, while the month since the first report lasts.
		await scheduleEscalation(owner, now, params.jobId);
		return;
	}

	const hosting = await hostingOf(target.id);
	const brand = brandRecipient(report.legalBrandUrl);
	const caseUrl = abuseEmailCaseUrl(report.submissionId);
	const facts: EscalationFacts = {
		domain: target.normalizedTarget,
		url,
		allegation: report.allegationCategory,
		reportedAt: firstSentAt(states) ?? report.createdAt,
		verification,
		...(caseUrl ? { caseUrl } : {}),
		...(hosting ? { hosting: hosting.text } : {}),
		...(brand ? { brand: brand.name } : {}),
	};
	// Each step stands alone: one provider's failure neither blocks nor repeats another's.
	let failure: unknown;
	for (const step of plan.due) {
		let outcome: Record<string, unknown>;
		try {
			outcome = await takeStep(step, { target, states, moved, facts, ...(hosting ? { hosting } : {}), dependencies });
		} catch (error) {
			// A message that may have gone out is never sent again: the step counts as taken.
			if (!(error instanceof UnknownExternalStateError)) {
				failure ??= error;
				continue;
			}
			outcome = { action: "unknown", error: error.message };
		}
		await AbuseRepository.appendEvent({
			reportId: report.id,
			targetId: target.id,
			...(step.routeId === undefined ? {} : { routeId: step.routeId }),
			eventType: ESCALATION_EVENT,
			data: { level: step.level, step: step.step, ...outcome, verification: verificationSummary(verification) },
		});
	}
	// A failed step is retried with the job; only a run whose steps all went through queues the next.
	if (failure !== undefined) throw failure;
	await scheduleEscalation(owner, now, params.jobId);
}
