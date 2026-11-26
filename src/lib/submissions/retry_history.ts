import { SubmissionRetriesEntity } from "@/lib/db/entities/submission_retries";
import type { SubmissionKind, SubmissionRetryTrigger, SubmissionStatus } from "@/lib/db/schema";
import type { WebsiteSiteFinding } from "@/lib/website/types";
import { caseFinding, caseReportedAs, type ReportedAs } from "./finding";

/** A case's status, finding and info line at one moment; a reported case says what it was reported for. */
export type CaseState = { status: SubmissionStatus; info: string | null; finding: WebsiteSiteFinding | null; reportedAs?: ReportedAs };

/** One retry as the operator's "Retried cases" view lists it: what the case stood at before, and what it stands at now. */
export type RetryHistoryEntry = {
	id: string;
	submissionId: string;
	kind: SubmissionKind;
	/** The submitted URL of a website, the subject of an email, else where the case came from. */
	target: string;
	trigger: SubmissionRetryTrigger;
	retriedAt: Date;
	/** Retries start from failed or invalid cases, which were reported for nothing. */
	before: CaseState;
	now: CaseState;
	/** How often the case was analyzed again in all. */
	caseRetryCount: number;
};

/** The newest retries of every case, newest first. Operator only: an email's subject is the reporter's mail. */
export async function listRetryHistory(limit = 200): Promise<RetryHistoryEntry[]> {
	return (await SubmissionRetriesEntity.listRecent(limit)).map((retry) => {
		const { submission } = retry;
		const target = submission.data.kind === "website"
			? submission.data.website.url
			: submission.data.email?.subject || submission.source || "Email";
		const reportedAs = submission.status === "reported" ? caseReportedAs(submission.data) : undefined;
		return {
			id: retry.id.toString(),
			submissionId: retry.submissionId.toString(),
			kind: submission.kind,
			target,
			trigger: retry.trigger,
			retriedAt: retry.createdAt,
			before: { status: retry.fromStatus, info: retry.previousInfo, finding: retry.previousFinding },
			now: { status: submission.status, info: submission.info, finding: caseFinding(submission.data) ?? null, ...(reportedAs ? { reportedAs } : {}) },
			caseRetryCount: retry.caseRetryCount,
		};
	});
}
