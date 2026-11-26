import { SubmissionRetriesEntity } from "@/lib/db/entities/submission_retries";
import type { SubmissionKind, SubmissionRetryTrigger, SubmissionStatus } from "@/lib/db/schema";
import type { WebsiteSiteFinding } from "@/lib/website/types";
import { caseFinding } from "./finding";

/** One retry as the operator's "Retried cases" view lists it: what the case stood at before, and what it stands at now. */
export type RetryHistoryEntry = {
	id: string;
	submissionId: string;
	kind: SubmissionKind;
	/** The submitted URL of a website, the subject of an email, else where the case came from. */
	target: string;
	trigger: SubmissionRetryTrigger;
	retriedAt: Date;
	before: { status: SubmissionStatus; info: string | null; finding: WebsiteSiteFinding | null };
	now: { status: SubmissionStatus; info: string | null; finding: WebsiteSiteFinding | null };
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
		return {
			id: retry.id.toString(),
			submissionId: retry.submissionId.toString(),
			kind: submission.kind,
			target,
			trigger: retry.trigger,
			retriedAt: retry.createdAt,
			before: { status: retry.fromStatus, info: retry.previousInfo, finding: retry.previousFinding },
			now: { status: submission.status, info: submission.info, finding: caseFinding(submission.data) ?? null },
			caseRetryCount: retry.caseRetryCount,
		};
	});
}
