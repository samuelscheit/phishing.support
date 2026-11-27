import { eq, and } from "drizzle-orm";

import { claimNextJob, completeJob } from "@/lib/abuse/persistence/jobs";
import { jobs } from "@/lib/abuse/schema";
import { getDb } from "@/lib/db";
import { WEBSITE_VISIT_JOB } from "./queue";
import { runWebsiteVisit, type WebsiteVisitDependencies } from "./run";

const OWNER = "test-visit-lane";

/**
 * Run the due website visits as the worker's visit lane does, one after
 * another, with this analysis (the real one when omitted). With `all`, a
 * scheduled automatic retry is due now too. Returns the cases visited, in order.
 */
export async function runQueuedVisits(
	analyzeWebsite?: WebsiteVisitDependencies["analyzeWebsite"],
	options: { all?: boolean } = {},
): Promise<bigint[]> {
	if (options.all) await makeQueuedVisitsDue();
	const ran: bigint[] = [];
	for (;;) {
		const job = await claimNextJob(OWNER, 60_000, { jobTypes: [WEBSITE_VISIT_JOB] });
		if (!job) return ran;
		await runWebsiteVisit(job, analyzeWebsite ? { analyzeWebsite } : {});
		await completeJob(job.id, OWNER);
		ran.push(BigInt(String(job.payload?.submissionId)));
	}
}

/** Bring every waiting visit forward to now: a test's way of letting a retry's backoff pass. */
export async function makeQueuedVisitsDue(): Promise<void> {
	(await getDb()).update(jobs).set({ nextAttemptAt: new Date(Date.now() - 1) }).where(and(eq(jobs.jobType, WEBSITE_VISIT_JOB), eq(jobs.status, "queued"))).run();
}

/** The visit jobs still waiting, oldest first. */
export async function queuedVisits() {
	return (await getDb()).select().from(jobs).where(and(eq(jobs.jobType, WEBSITE_VISIT_JOB), eq(jobs.status, "queued"))).all()
		.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}
