import { latestJobByDedupeKey, replaceQueuedJob } from "@/lib/abuse/persistence/jobs";
import type { Job } from "@/lib/abuse/schema";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import type { Submission, SubmissionStatus } from "@/lib/db/schema";

/**
 * Every website analysis is one `visit_website` job in the worker's `visit`
 * lane: a durable queue with a global concurrency cap, shared fairly between
 * reporters and resumed after a restart (see docs/design/visit-queue-domain-grouping.md).
 */
export const WEBSITE_VISIT_JOB = "visit_website" as const;

/** The name of the MHTML a reporter submitted with the URL, kept for the case's first visit. */
export const REPORTER_MHTML_NAME = "reporter-submitted.mhtml";

/**
 * Why a visit runs: the case's first visit, a retry someone asked for, or the
 * automatic retry of a failure another visit can change.
 */
export type VisitTrigger = "initial" | "manual" | "automatic";

export type WebsiteVisitPayload = {
	submissionId: string;
	trigger: VisitTrigger;
	/**
	 * The status a manual retry took the case from: the archive the case
	 * already holds is reused only for a failed case (see `retryAnalysisOptions`).
	 */
	fromStatus?: SubmissionStatus;
};

/** The dedupe key of a case's visit: one waiting visit per case. */
export function visitJobKey(submissionId: bigint): string {
	return `website-visit:${submissionId.toString()}`;
}

/**
 * A job that needs a case's visit to finish first (a redirector watch reading
 * where its visit led): it did nothing and checks again later, spending none
 * of its attempts (`jobWaitOf`).
 */
export class WebsiteVisitPendingError extends Error {
	readonly retryAfterMs = 60_000;
	constructor(readonly submissionId: bigint) {
		super(`The visit of case ${submissionId.toString()} has not finished yet.`);
	}
}

/** Whether a case still waits for its visit or is in it. */
export function isVisitPending(status: SubmissionStatus | undefined): boolean {
	return status === "queued" || status === "running";
}

/**
 * One visit of a site group runs at a time: the hosts of one registrable
 * domain are visited one after another, never side by side (a case without a
 * group, one at a time by itself).
 */
export function visitSerialKey(submission: Pick<Submission, "id" | "siteGroup">): string {
	return submission.siteGroup ? `site:${submission.siteGroup}` : `visit:${submission.id.toString()}`;
}

/**
 * The reporter a case's visits count against: its reporter's address, else
 * the kind of source that opened it (`email`, `kit-sibling`, …).
 */
export function fairKeyOf(reporter: { reporterIp?: string | null; source?: string | null }): string {
	if (reporter.reporterIp) return `ip:${reporter.reporterIp}`;
	const origin = reporter.source?.split(":")[0];
	return `source:${origin || "unknown"}`;
}

/**
 * The fair key a case's visits count against: the one its earlier visit was
 * queued under (a case opened for another case inherits that case's), else
 * its own reporter's.
 */
export async function fairKeyOfCase(submission: Pick<Submission, "id" | "reporterIp" | "source">): Promise<string> {
	return (await latestJobByDedupeKey(visitJobKey(submission.id)))?.fairKey ?? fairKeyOf(submission);
}

/** The fair key of a case found by id; a case that no longer exists has the `unknown` source's. */
export async function fairKeyOfCaseId(submissionId: bigint | null | undefined): Promise<string | undefined> {
	if (submissionId === undefined || submissionId === null) return undefined;
	const submission = await SubmissionsEntity.get(submissionId);
	return submission ? fairKeyOfCase(submission) : undefined;
}

/**
 * Queue a visit of a case, replacing the one still waiting for it: a manual
 * retry takes the place of a scheduled automatic one, at once.
 */
export async function enqueueWebsiteVisit(params: {
	submission: Pick<Submission, "id" | "reporterIp" | "source" | "siteGroup">;
	trigger: VisitTrigger;
	fromStatus?: SubmissionStatus;
	/** Not before then (an automatic retry's backoff). */
	notBefore?: Date;
	/** The share it counts against; by default the case's own (`fairKeyOfCase`). */
	fairKey?: string;
}): Promise<Job> {
	const { submission } = params;
	const payload: WebsiteVisitPayload = {
		submissionId: submission.id.toString(),
		trigger: params.trigger,
		...(params.fromStatus ? { fromStatus: params.fromStatus } : {}),
	};
	return replaceQueuedJob({
		jobType: WEBSITE_VISIT_JOB,
		dedupeKey: visitJobKey(submission.id),
		payload,
		fairKey: params.fairKey ?? await fairKeyOfCase(submission),
		serialKey: visitSerialKey(submission),
		nextAttemptAt: params.notBefore,
	});
}
