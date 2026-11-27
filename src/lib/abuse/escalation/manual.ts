import { getReportsByIds } from "../../submissions/abuse_details";
import type { PlannedEscalationStep } from "../../submissions/planned_escalation";
import { nextPerTarget } from "../../submissions/report_view";
import { asRecord } from "../../util/values";
import { OperatorActionError } from "../approval/drafted_mail";
import { AbuseRepository } from "../repository";
import type { AbuseEvent } from "../schema";
import { ESCALATION_ADVANCED_EVENT, ESCALATION_EVENT, escalates, escalationJobKey, isSkipped } from "./ladder";
import { pendingEscalationSteps } from "./policy";
import { escalationState, scheduleEscalation } from "./run";

/** The operator settled a step only a person can take: filed the ICANN complaint, or decided what to do after the ladder. */
const ESCALATION_STEP_RESOLVED_EVENT = "escalation.step_resolved";

/**
 * A step of the ladder waiting for the operator:
 * - `icann_complaint`: the complaint against a gTLD registrar, filed by hand
 *   through ICANN's web form with the prepared text.
 * - `decision`: the ladder is done and the site is still up.
 */
export type OpenEscalationStep = {
	eventId: string;
	kind: "icann_complaint" | "decision";
	reportId: string;
	target: string;
	at: string;
	caseHref?: string;
	formUrl?: string;
	registrar?: string;
	text?: string;
};

function stepOf(event: AbuseEvent): Omit<OpenEscalationStep, "eventId" | "reportId" | "target" | "at" | "caseHref"> | undefined {
	if (isSkipped(event)) return undefined;
	const data = asRecord(event.data);
	if (data?.step === "exhausted") return { kind: "decision" };
	const [icann] = Array.isArray(data?.manual) ? data.manual.map(asRecord) : [];
	if (data?.step !== "oversight" || icann?.kind !== "icann_complaint") return undefined;
	return {
		kind: "icann_complaint",
		...(typeof icann.formUrl === "string" ? { formUrl: icann.formUrl } : {}),
		...(typeof icann.registrar === "string" ? { registrar: icann.registrar } : {}),
		...(typeof icann.text === "string" ? { text: icann.text } : {}),
	};
}

/** Every step only a person can take that no one settled yet, oldest first. */
export async function openEscalationSteps(): Promise<OpenEscalationStep[]> {
	const [steps, resolved] = await Promise.all([AbuseRepository.listEventsOfType(ESCALATION_EVENT), AbuseRepository.listEventsOfType(ESCALATION_STEP_RESOLVED_EVENT)]);
	const settled = new Set(resolved.map((event) => String(asRecord(event.data)?.eventId)));
	const open: OpenEscalationStep[] = [];
	for (const event of steps) {
		const step = stepOf(event);
		if (!step || settled.has(event.id.toString())) continue;
		const [report, target] = await Promise.all([AbuseRepository.getReport(event.reportId), event.targetId === null ? undefined : AbuseRepository.getTarget(event.targetId)]);
		if (!report || report.status === "canceled") continue;
		open.push({
			eventId: event.id.toString(),
			reportId: report.id.toString(),
			target: target?.normalizedTarget ?? "",
			at: event.createdAt.toISOString(),
			...(report.submissionId ? { caseHref: `/submissions/${report.submissionId.toString()}` } : {}),
			...step,
		});
	}
	return open;
}

/** A step of the ladder still to come, as the operator's queue lists it; dates as ISO text for the page. */
export type UpcomingEscalationStep = Pick<PlannedEscalationStep, "key" | "step" | "advanced" | "due" | "to"> & {
	targetId: string;
	at: string;
	heldUntil?: string;
	target: string;
	/** The provider a route's step is about; none for a step of the whole site. */
	provider?: string;
	caseHref?: string;
};

/**
 * The next step of every route still on a ladder, and the next step of
 * every site, soonest first: what the escalation jobs will take next unless
 * the operator sends it now or skips it. Read from the case view, which
 * reads the ladder the jobs take the steps from (a canceled report has none).
 */
export async function upcomingEscalationSteps(now = new Date()): Promise<UpcomingEscalationStep[]> {
	const reports = await getReportsByIds(await AbuseRepository.listReportsWithQueuedJob("escalate_target"), now);
	const upcoming = reports.flatMap((report) => {
		const nearest = [
			...report.routes.flatMap((route) => route.escalation.slice(0, 1).map((step) => ({ step, provider: route.organisation as string | undefined }))),
			...nextPerTarget(report.siteEscalation).map((step) => ({ step, provider: undefined })),
		];
		return nearest.map(({ step, provider }): UpcomingEscalationStep => ({
			key: step.key,
			step: step.step,
			advanced: step.advanced,
			due: step.due,
			...(step.to ? { to: step.to } : {}),
			targetId: step.targetId.toString(),
			at: step.at.toISOString(),
			...(step.heldUntil ? { heldUntil: step.heldUntil.toISOString() } : {}),
			target: step.target,
			...(provider ? { provider } : {}),
			...(report.submissionId ? { caseHref: `/submissions/${report.submissionId.toString()}` } : {}),
		}));
	});
	return upcoming.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The step of the target's ladder still to take under `key`, with the
 * target's escalation job. Refused for a target the job does not act on or
 * whose job is not queued (its site is down, its ladder ended: what the
 * operator's list shows neither), while the job runs (it read the ladder
 * before its check and takes what it read), and for a step taken, skipped
 * or no longer planned.
 */
async function pendingStep(targetId: bigint, key: string, now: Date) {
	const [target, job] = await Promise.all([AbuseRepository.getTarget(targetId), AbuseRepository.latestJobByDedupeKey(escalationJobKey(targetId))]);
	const report = target && await AbuseRepository.getReport(target.reportId);
	if (job?.status === "running") throw new OperatorActionError("This site's escalation is running right now; try again in a few minutes.");
	if (!target || !report || !escalates(report, target) || job?.status !== "queued") throw new OperatorActionError("This site is not on an escalation ladder (it is down, or its ladder ended); reload the page.");
	const { ladder } = await escalationState(target.reportId, targetId);
	const step = pendingEscalationSteps(ladder, now).find((candidate) => candidate.key === key);
	if (!step) throw new OperatorActionError("This step was taken or skipped already, or is no longer planned; reload the page.");
	return { owner: { reportId: target.reportId, targetId }, step, job };
}

/**
 * Take a planned step now instead of when it is due: a step not due yet, or
 * held, is recorded as brought forward (which lifts the hold), and the
 * target's escalation job is queued for now. A step already due with its job
 * due is going out already: refused, as the operator's list shows it "due".
 * The job still checks that the site serves the reported content before it
 * takes the step.
 */
export async function sendEscalationStepNow(targetId: bigint, key: string, now = new Date()): Promise<void> {
	const { owner, step, job } = await pendingStep(targetId, key, now);
	const due = step.at.getTime() <= now.getTime();
	if (due && job.nextAttemptAt.getTime() <= now.getTime()) throw new OperatorActionError("This step is due and goes out with the next run of its escalation; reload the page.");
	if (!due) await AbuseRepository.appendEvent({ ...owner, ...(step.routeId === undefined ? {} : { routeId: step.routeId }), eventType: ESCALATION_ADVANCED_EVENT, data: { level: step.level, step: step.step, at: now.toISOString() } });
	await scheduleEscalation(owner, now);
}

/** Leave a planned step out: it is recorded as taken (`skipped`), so the ladder moves on and the job never takes it. */
export async function skipEscalationStep(targetId: bigint, key: string, now = new Date()): Promise<void> {
	const { owner, step } = await pendingStep(targetId, key, now);
	await AbuseRepository.appendEvent({ ...owner, ...(step.routeId === undefined ? {} : { routeId: step.routeId }), eventType: ESCALATION_EVENT, data: { level: step.level, step: step.step, action: "skipped", skipped: true } });
	await scheduleEscalation(owner, now);
}

/** Settle a step only a person can take, once. */
export async function resolveEscalationStep(eventId: bigint, resolution: "filed" | "dismissed"): Promise<void> {
	const event = await AbuseRepository.getEvent(eventId);
	if (!event || event.eventType !== ESCALATION_EVENT || !stepOf(event)) throw new OperatorActionError("This is not an escalation step waiting for you.");
	if ((await AbuseRepository.listEvents(event.reportId)).some((candidate) => candidate.eventType === ESCALATION_STEP_RESOLVED_EVENT && asRecord(candidate.data)?.eventId === eventId.toString())) {
		throw new OperatorActionError("This step was settled already; reload the page.");
	}
	await AbuseRepository.appendEvent({
		reportId: event.reportId,
		...(event.targetId === null ? {} : { targetId: event.targetId }),
		eventType: ESCALATION_STEP_RESOLVED_EVENT,
		data: { eventId: eventId.toString(), resolution },
	});
}
