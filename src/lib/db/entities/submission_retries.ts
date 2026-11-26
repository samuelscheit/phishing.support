import { and, count, desc, eq, max, sql } from "drizzle-orm";
import { caseFinding } from "@/lib/submissions/finding";
import { getDb } from "../index";
import { submissionRetries, submissions, type Submission, type SubmissionRetry, type SubmissionRetryTrigger, type SubmissionStatus } from "../schema";
import { generateId } from "../ids";

/** A retry with the case as it stands now and how often that case was retried in all. */
export type SubmissionRetryWithCase = SubmissionRetry & {
	submission: Pick<Submission, "kind" | "source" | "data" | "status" | "info">;
	caseRetryCount: number;
};

export class SubmissionRetriesEntity {
	/**
	 * Claim a case for a retry: move it from `from` to running and record the
	 * retry with the info and finding it had, in one transaction. Only the
	 * request that moves it records a retry; a concurrent one finds the case no
	 * longer at `from` and gets false.
	 */
	static async claim(params: { submissionId: bigint; from: SubmissionStatus; trigger: SubmissionRetryTrigger }): Promise<boolean> {
		const db = await getDb();
		return db.transaction((tx) => {
			const before = tx
				.select({ info: submissions.info, data: submissions.data })
				.from(submissions)
				.where(and(eq(submissions.id, params.submissionId), eq(submissions.status, params.from)))
				.get();
			if (!before) return false;
			const now = new Date();
			tx.update(submissions).set({ status: "running", updatedAt: now }).where(eq(submissions.id, params.submissionId)).run();
			tx.insert(submissionRetries).values({
				id: generateId(),
				submissionId: params.submissionId,
				fromStatus: params.from,
				previousInfo: before.info,
				previousFinding: caseFinding(before.data) ?? null,
				trigger: params.trigger,
				createdAt: now,
			}).run();
			return true;
		}, { behavior: "immediate" });
	}

	static async listForSubmission(submissionId: bigint): Promise<SubmissionRetry[]> {
		const db = await getDb();
		return db.select().from(submissionRetries).where(eq(submissionRetries.submissionId, submissionId)).orderBy(desc(submissionRetries.createdAt), desc(submissionRetries.id));
	}

	/** How often a case was analyzed again, and when last. */
	static async summaryForSubmission(submissionId: bigint): Promise<{ count: number; lastAt: Date | null }> {
		const db = await getDb();
		const [row] = await db
			.select({ count: count(), lastAt: max(submissionRetries.createdAt) })
			.from(submissionRetries)
			.where(eq(submissionRetries.submissionId, submissionId));
		return { count: row?.count ?? 0, lastAt: row?.lastAt ?? null };
	}

	/** The newest retries of every case, each with its case now. */
	static async listRecent(limit = 200): Promise<SubmissionRetryWithCase[]> {
		const db = await getDb();
		const caseRetryCount = sql<number>`(SELECT count(*) FROM ${submissionRetries} AS "all_retries" WHERE "all_retries"."submission_id" = ${submissionRetries.submissionId})`.mapWith(Number);
		const rows = await db
			.select({
				retry: submissionRetries,
				submission: { kind: submissions.kind, source: submissions.source, data: submissions.data, status: submissions.status, info: submissions.info },
				caseRetryCount,
			})
			.from(submissionRetries)
			.innerJoin(submissions, eq(submissions.id, submissionRetries.submissionId))
			.orderBy(desc(submissionRetries.createdAt), desc(submissionRetries.id))
			.limit(limit);
		return rows.map(({ retry, submission, caseRetryCount }) => ({ ...retry, submission, caseRetryCount }));
	}
}
