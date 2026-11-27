import { asRecord } from "../../util/values";
import { OperatorActionError } from "../approval/drafted_mail";
import { AbuseRepository } from "../repository";
import type { AbuseEvent } from "../schema";
import { ESCALATION_EVENT } from "./run";

/** The operator settled a step only a person can take: filed the ICANN complaint, or decided what to do after the ladder. */
export const ESCALATION_STEP_RESOLVED_EVENT = "escalation.step_resolved";

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
