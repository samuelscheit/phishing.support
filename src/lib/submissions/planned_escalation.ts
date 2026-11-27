import { contactForStep, escalates, escalationJobKey, firstSentAt, targetLadder, type LadderRouteState } from "@/lib/abuse/escalation/ladder";
import { followUpNotice, plannedFacts, type PlannedFacts } from "@/lib/abuse/escalation/notice";
import { pendingEscalationSteps, type EscalationStep, type EscalationStepName } from "@/lib/abuse/escalation/policy";
import { noticeRecipient } from "@/lib/abuse/followup/route_notice";
import { abuseEmailCaseUrl } from "@/lib/abuse/mail/draft";
import { getProviderSubmissionProvider } from "@/lib/abuse/providers/submission_registry_default";
import { remainingContacts } from "@/lib/abuse/resolver/contact_chain";
import type { AbuseEvent, AbuseProviderRoute, AbuseReport, AbuseTarget, Job } from "@/lib/abuse/schema";
import type { SiteCheck } from "@/lib/liveness/schema";
import type { SubmissionReportRoute } from "./abuse_details";

/**
 * A step of the escalation ladder still to come (abuse/escalation), as the
 * case page and the operator see it. A route's own steps carry `routeId`;
 * the site's (oversight, exhausted) do not.
 */
export type PlannedEscalationStep = {
	/** The step's key on its target's ladder (`route:<id>:<level>`, `site:<level>`). */
	key: string;
	targetId: bigint;
	/** The target's name: the site the step escalates. */
	target: string;
	step: EscalationStepName;
	routeId?: bigint;
	/** When the ladder takes it: when it falls due, or when a hold ends. */
	at: Date;
	/** A check found the site not (confirmably) serving the reported content: the ladder waits until then. */
	heldUntil?: Date;
	/** The operator brought it forward. */
	advanced: boolean;
	/** Its time came and it is not taken yet. */
	due: boolean;
	/** Whom it reaches, when that is known before it runs: the provider's mailbox or follow-up channel, its next published contact, its upstream provider. */
	to?: { name: string; address: string };
	/** What it sends, when that is known before the check right before sending. */
	draft?: string;
};

type RouteView = Omit<SubmissionReportRoute, "escalation">;
type State = LadderRouteState<AbuseProviderRoute, RouteView>;

/**
 * Whom a route's step reaches and what it sends, as far as known now; undefined
 * for a step that will reach no one (a provider without a follow-up channel, a
 * route without a further contact), which the ladder records as taken
 * without doing anything.
 */
function reach(step: EscalationStep, state: State, reached: ReadonlyArray<string | null>, facts: PlannedFacts | undefined): Pick<PlannedEscalationStep, "to" | "draft"> | undefined {
	const { route, view } = state;
	if (step.step === "follow_up") {
		const address = noticeRecipient(route, view.confirmationId);
		if (!address) return undefined;
		const addressee = getProviderSubmissionProvider(route.providerRegistryKey)?.decisionFollowUp?.addressee;
		return {
			to: { name: view.organisation, address },
			...(facts ? { draft: followUpNotice({ organisation: view.organisation, ...(addressee ? { addressee } : {}), facts, ...(view.confirmationId ? { reference: view.confirmationId } : {}) }) } : {}),
		};
	}
	if (step.step !== "next_contact" && step.step !== "upstream") return {};
	const contact = route.routeType === "email" ? remainingContacts(route.resolverProvenance, reached).find(contactForStep(step.step)) : undefined;
	if (!contact) return undefined;
	const name = [contact.organization, contact.entityName].find((value) => typeof value === "string" && value.trim());
	return { to: { name: typeof name === "string" ? name : contact.email, address: contact.email } };
}

/**
 * The escalation steps still to come for the report's targets at `now`,
 * soonest first, read from the same ladder the escalation job takes them
 * from. Only a target the job acts on (`escalates`) and whose job is queued
 * has any: the job is what takes them, and liveness queues it only while the
 * site is up.
 */
export function plannedEscalation(params: {
	report: Pick<AbuseReport, "status" | "submissionId" | "allegationCategory" | "legalBrandUrl">;
	targets: readonly Pick<AbuseTarget, "id" | "normalizedTarget" | "observedUrls">[];
	routes: readonly AbuseProviderRoute[];
	views: readonly RouteView[];
	events: readonly AbuseEvent[];
	checks: readonly Pick<SiteCheck, "targetId" | "hosting">[];
	queuedJobs: readonly Pick<Job, "dedupeKey">[];
	now: Date;
}): PlannedEscalationStep[] {
	const { report, now } = params;
	const caseUrl = abuseEmailCaseUrl(report.submissionId);
	return params.targets.flatMap((target) => {
		const url = target.observedUrls[0];
		if (!url || !escalates(report, target) || !params.queuedJobs.some((job) => job.dedupeKey === escalationJobKey(target.id))) return [];
		const ladder = targetLadder(target.id, params.routes, params.views, params.events);
		const reportedAt = firstSentAt(ladder.states);
		const facts = reportedAt
			? plannedFacts({ domain: target.normalizedTarget, url, allegation: report.allegationCategory, reportedAt, ...(caseUrl ? { caseUrl } : {}), hosting: params.checks.findLast((check) => check.targetId === target.id)?.hosting, brandUrl: report.legalBrandUrl })
			: undefined;
		const reached = params.routes.filter((route) => route.targetId === target.id).map((route) => route.verifiedEmail);
		return pendingEscalationSteps(ladder.ladder, now).flatMap((step): PlannedEscalationStep[] => {
			const state = step.routeId === undefined ? undefined : ladder.states.find((candidate) => candidate.route.id === step.routeId);
			const known = state ? reach(step, state, reached, facts) : {};
			if (!known) return [];
			return [{
				key: step.key,
				targetId: target.id,
				target: target.normalizedTarget,
				step: step.step,
				...(step.routeId === undefined ? {} : { routeId: step.routeId }),
				at: step.at,
				...(step.heldUntil ? { heldUntil: step.heldUntil } : {}),
				advanced: step.advanced,
				due: step.at.getTime() <= now.getTime(),
				...known,
			}];
		});
	}).sort((a, b) => a.at.getTime() - b.at.getTime());
}
