import { verifyReportedContent, stillAbusive, type ContentVerification, type ContentVerificationDependencies } from "../../liveness/content";
import { listSiteChecksForTargets } from "../../liveness/repository";
import { registeredCountry } from "../../network/ripestat";
import { getReportsByIds } from "../../submissions/abuse_details";
import { asRecord } from "../../util/values";
import { draftMailRoute } from "../approval/drafted_mail";
import { sendRouteNotice } from "../followup/route_notice";
import { abuseEmailCaseUrl } from "../mail/draft";
import type { sendAbuseEmailRoute } from "../mail/send";
import { getProviderSubmissionProvider } from "../providers";
import { AbuseRepository } from "../repository";
import { routeContact } from "../resolver/contact_chain";
import type { AbuseProviderRoute, AbuseTarget } from "../schema";
import { routeToContact } from "../worker/mail";
import { UnknownExternalStateError } from "../worker/shared";
import { contactForStep, ESCALATION_EVENT, ESCALATION_HELD_EVENT, escalationJobKey, firstSentAt, targetLadder, type LadderRouteState } from "./ladder";
import { brandDraft, certDraft, dsaNoticeDraft, followUpNotice, hostingOf, icannComplaintText, plannedFacts, type Draft, type EscalationFacts, type UnactedProvider } from "./notice";
import { escalationPlan, ESCALATED_ROLES, type EscalationStep } from "./policy";
import { brandRecipient, DSA_COUNTRIES, ICANN_COMPLAINT, isGenericTld, NATIONAL_CERTS } from "./recipients";

export type EscalationDependencies = {
	verify?: ContentVerificationDependencies;
	send?: typeof sendAbuseEmailRoute;
	providerFor?: typeof getProviderSubmissionProvider;
	/** The country a network's AS is registered in; production asks RIPEstat. */
	countryOf?: (asn: number) => Promise<string | undefined>;
	now?: () => Date;
};

type RouteState = LadderRouteState<AbuseProviderRoute>;

/** The target's ladder as its records stand, read the way the case page reads it. */
export async function escalationState(reportId: bigint, targetId: bigint) {
	const [routes, [view], events] = await Promise.all([AbuseRepository.listRoutes(reportId), getReportsByIds([reportId]), AbuseRepository.listEvents(reportId)]);
	return targetLadder(targetId, routes, view?.routes ?? [], events);
}

/**
 * Queue the target's escalation job for when its next step falls due (now
 * when one already is), or nothing once the ladder is done; a hold delays
 * it. One job per target; a later call moves it earlier, never later. A
 * running escalation job passes itself as `successorOf` to queue the next.
 */
export async function scheduleEscalation(target: { reportId: bigint; targetId: bigint }, now = new Date(), successorOf?: bigint): Promise<void> {
	const { ladder, heldUntil } = await escalationState(target.reportId, target.targetId);
	const plan = escalationPlan(ladder, now);
	const due = plan.due.length ? now : plan.nextAt;
	if (!due) return;
	await queueEscalation(target, heldUntil && heldUntil > due ? heldUntil : due, successorOf);
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
function climbing(context: Pick<StepContext, "states">): RouteState[] {
	return context.states.filter(({ ladder }) => ESCALATED_ROLES.has(ladder.role) && ladder.sentAt && ladder.decision !== "action_taken" && !ladder.left);
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
	facts: EscalationFacts;
	hosting?: { text: string; asn?: number };
	dependencies: EscalationDependencies;
};

/** The ladder's own steps; each returns what it did, which its event records. */
async function takeStep(step: EscalationStep, context: StepContext): Promise<Record<string, unknown>> {
	const state = step.routeId === undefined ? undefined : context.states.find((candidate) => candidate.route.id === step.routeId);
	switch (step.step) {
		case "follow_up": {
			const { route, view } = state!;
			const addressee = (context.dependencies.providerFor ?? getProviderSubmissionProvider)(route.providerRegistryKey)?.decisionFollowUp?.addressee;
			const body = followUpNotice({ organisation: view.organisation, ...(addressee ? { addressee } : {}), facts: context.facts, ...(view.confirmationId ? { reference: view.confirmationId } : {}) });
			const outcome = await sendRouteNotice(route, { body, attachments: [], correlationKey: `escalation:${route.id.toString()}:${step.level}` }, {
				...(context.dependencies.send ? { send: context.dependencies.send } : {}),
				...(context.dependencies.providerFor ? { providerFor: context.dependencies.providerFor } : {}),
			});
			return outcome.status === "sent" ? { action: "followed_up", to: outcome.to } : { action: outcome.status };
		}
		case "next_contact":
		case "upstream": {
			const { route } = state!;
			const earlier = createdBy(route.id, step.level, await AbuseRepository.listRoutes(route.reportId));
			if (earlier) return { action: "reported", routeId: earlier.id.toString(), to: earlier.verifiedEmail };
			const created = await routeToContact(route.id, {
				choose: contactForStep(step.step),
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
	// Each draft says why it goes to its recipient, for the operator who approves it.
	const drafts: Array<{ kind: string; to: string; draft: Draft; label: string; reason: string }> = [];
	const network = context.hosting?.asn !== undefined ? `AS${context.hosting.asn}` : "the hosting network";
	const cert = country ? NATIONAL_CERTS[country] : undefined;
	if (cert && country) drafts.push({ kind: "cert", to: cert.email, label: cert.name, draft: certDraft({ cert, country, facts, unacted: providers }), reason: `${network} is registered in ${country}; ${cert.name} is its national CERT (${cert.source}).` });
	if (country && DSA_COUNTRIES.has(country)) {
		for (const state of unanswered.filter((candidate) => candidate.ladder.role === "host" && candidate.route.verifiedEmail)) {
			drafts.push({ kind: "dsa_notice", to: state.route.verifiedEmail!, label: state.view.organisation, draft: dsaNoticeDraft({ host: unacted(state), facts }), reason: `${state.view.organisation} has not acted on our report, and ${network} is registered in ${country} (EU/EEA): a notice under Art. 16 DSA obliges a host serving the EU to decide on it. Check that it serves EU users.` });
		}
	}
	const brand = brandRecipient((await AbuseRepository.getReport(target.reportId))?.legalBrandUrl);
	if (brand) drafts.push({ kind: "brand", to: brand.email, label: brand.name, draft: brandDraft({ brand, facts, unacted: providers }), reason: `The site impersonates ${brand.name}, which takes reports of fake sites at ${brand.email} (${brand.source}).` });

	const drafted = [];
	for (const { kind, to, label, draft, reason } of drafts) {
		const route = await draftMailRoute({
			targetId: target.id,
			routeKey: `escalation:${kind}:${to.toLowerCase()}`,
			registryKey: `escalation:${kind}`,
			recipient: to,
			recipientLabel: label,
			draft,
			provenance: { source: "escalation_oversight", kind },
			snapshot: { escalationKind: kind, escalationReason: reason },
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
	const { states, ladder } = await escalationState(report.id, target.id);
	const plan = escalationPlan(ladder, now);
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

	const check = (await listSiteChecksForTargets([target.id])).at(-1);
	const hosting = hostingOf(check?.hosting);
	const caseUrl = abuseEmailCaseUrl(report.submissionId);
	const facts: EscalationFacts = {
		...plannedFacts({ domain: target.normalizedTarget, url, allegation: report.allegationCategory, reportedAt: firstSentAt(states) ?? report.createdAt, ...(caseUrl ? { caseUrl } : {}), hosting: check?.hosting, brandUrl: report.legalBrandUrl }),
		verification,
	};
	// Each step stands alone: one provider's failure neither blocks nor repeats another's.
	let failure: unknown;
	for (const step of plan.due) {
		let outcome: Record<string, unknown>;
		try {
			outcome = await takeStep(step, { target, states, facts, ...(hosting ? { hosting } : {}), dependencies });
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
