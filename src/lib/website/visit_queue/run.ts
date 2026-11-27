import { activeJobByDedupeKey } from "@/lib/abuse/persistence/jobs";
import type { Job } from "@/lib/abuse/schema";
import { getDb } from "@/lib/db";
import { ArtifactsEntity } from "@/lib/db/entities/artifacts";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import type { Submission, SubmissionStatus, WebsiteSubmissionData } from "@/lib/db/schema";
import { claimRetry, getRetryableSubmission, SubmissionRetryError } from "@/lib/submissions/retry";
import { analyzeWebsite, type AnalyzeWebsiteOptions } from "../analysis/ai";
import { failWebsiteAnalysis } from "../analysis/failure";
import { analyzedPage, latestArtifactNamed, navigationToPage, websiteCaptureFileNames } from "../visit/capture_files";
import { enqueueWebsiteVisit, REPORTER_MHTML_NAME, visitJobKey, type VisitTrigger, type WebsiteVisitPayload } from "./queue";

type WebsiteCase = Submission & { data: { kind: "website"; website: WebsiteSubmissionData } };

function isWebsiteCase(submission: Submission | undefined): submission is WebsiteCase {
	return submission?.kind === "website" && submission.data.kind === "website";
}

function readPayload(payload: Job["payload"]): { submissionId: bigint; trigger: VisitTrigger; fromStatus?: SubmissionStatus } {
	const { submissionId, trigger, fromStatus } = (payload ?? {}) as Partial<WebsiteVisitPayload>;
	if (typeof submissionId !== "string" || !/^\d+$/.test(submissionId)) throw new Error("A website visit job names no case.");
	if (trigger !== "initial" && trigger !== "manual" && trigger !== "automatic") throw new Error(`A website visit job has an unknown trigger: ${String(trigger)}.`);
	return { submissionId: BigInt(submissionId), trigger, ...(fromStatus ? { fromStatus } : {}) };
}

const reporterOf = (submission: Submission) => ({
	reporterIp: submission.reporterIp ?? undefined,
	reporterCountry: submission.reporterCountry ?? undefined,
	reporterHeaders: submission.reporterHeaders ?? undefined,
});

/** A case's first visit: what its reporter submitted, the MHTML they sent along included. */
async function initialAnalysisOptions(submission: WebsiteCase): Promise<AnalyzeWebsiteOptions> {
	const { url, instructions } = submission.data.website;
	const uploaded = latestArtifactNamed(await ArtifactsEntity.listForSubmission(submission.id), REPORTER_MHTML_NAME);
	const mhtmlSnapshot = uploaded ? (await ArtifactsEntity.get(uploaded.id))?.blob : undefined;
	return {
		submissionId: submission.id,
		url,
		...(instructions ? { instructions } : {}),
		...(mhtmlSnapshot?.byteLength ? { mhtmlSnapshot } : {}),
		...reporterOf(submission),
	};
}

/**
 * A retry's visit. A failed case whose capture shows the site's first walk
 * keeps it: the retry analyzes the archive it holds instead of a new visit.
 * A cloaked capture holds only the decoy, and an unfinished flow only the
 * page before the step it could not take, often a one-time gate URL that no
 * longer loads; a retry must visit the site again from the submitted URL.
 * A page of a rotating link's later route is not where the link leads a
 * first walk, which a retry starts again as.
 */
export async function retryAnalysisOptions(submission: WebsiteCase, fromStatus: SubmissionStatus | undefined): Promise<AnalyzeWebsiteOptions> {
	const websiteData = submission.data.website;
	const { url, instructions } = websiteData;
	const analyzed = analyzedPage(websiteData);
	const artifactList = await ArtifactsEntity.listForSubmission(submission.id);
	const names = websiteCaptureFileNames(analyzed?.page ?? { route: 0, step: 0 });
	const mhtmlArtifact = latestArtifactNamed(artifactList, names.mhtml);
	const screenshotArtifact = latestArtifactNamed(artifactList, names.screenshot);
	const trusted = Boolean(
		fromStatus === "failed"
		&& analyzed
		&& analyzed.page.route === 0
		&& websiteData.cloaking?.outcome !== "unresolved"
		&& !websiteData.unfinishedFlow,
	);
	const blobOf = async (artifact: { id: bigint } | undefined) => {
		if (!artifact || !trusted) return undefined;
		const blob = (await ArtifactsEntity.get(artifact.id))?.blob;
		return blob?.byteLength ? blob : undefined;
	};
	const mhtmlSnapshot = await blobOf(mhtmlArtifact);
	const screenshotSnapshot = await blobOf(screenshotArtifact);
	return {
		submissionId: submission.id,
		url,
		...(instructions ? { instructions } : {}),
		mhtmlSnapshot,
		archivedUrl: analyzed?.hop.url,
		navigationHops: analyzed ? navigationToPage(analyzed.hops, analyzed.hop) : undefined,
		trustMhtmlDocumentLocation: Boolean(mhtmlSnapshot),
		verificationGate: mhtmlSnapshot ? websiteData.verificationGate : undefined,
		kitResources: mhtmlSnapshot ? websiteData.kitResources : undefined,
		hiddenFrames: mhtmlSnapshot ? websiteData.hiddenFrames : undefined,
		device: mhtmlSnapshot ? websiteData.device : undefined,
		screenshotSnapshot,
		...reporterOf(submission),
		reuseEvidenceArtifacts: Boolean(mhtmlSnapshot && screenshotArtifact),
	};
}

/**
 * A visit its process died in (a restart, a crash): queued for the automatic
 * retry like a browser-service failure, so a visit that keeps killing the
 * process ends after the retry budget. The retry boundary still refuses a
 * case that reached reporting, so nothing is reported twice.
 */
async function failInterruptedVisit(submission: WebsiteCase): Promise<void> {
	const reason = "The server restarted during the visit.";
	await SubmissionsEntity.failRunningAnalysisRuns(submission.id, reason);
	await failWebsiteAnalysis(submission.id, {
		info: reason,
		retry: { attempts: submission.data.website.autoRetry?.attempts ?? 0, reason, exhausted: (visits) => `It was cut off ${visits} times; retry to visit the site again.` },
	});
}

/** A scheduled automatic retry the retry boundary refuses is dropped: the case shows no retry that will not come. */
async function dropAutomaticRetry(submission: WebsiteCase, error: SubmissionRetryError): Promise<void> {
	console.warn(`Automatic retry of website analysis ${submission.id.toString()} skipped: ${error.message}`);
	if (!submission.data.website.autoRetry) return;
	await SubmissionsEntity.update(submission.id, { data: { kind: "website", website: { ...submission.data.website, autoRetry: undefined } } });
}

export type WebsiteVisitDependencies = {
	/** The job's signal: aborted, the visit ends at its next step and the case waits for the job's recovery. */
	signal?: AbortSignal;
	analyzeWebsite?: (options: AnalyzeWebsiteOptions, dependencies: { signal?: AbortSignal }) => Promise<unknown>;
};

/**
 * Run one queued visit. A job that finds its case where its trigger no
 * longer applies (reported, retried by hand, deleted) does nothing; one that
 * finds its case still running was cut off by the process dying in it.
 */
export async function runWebsiteVisit(job: Pick<Job, "payload">, dependencies: WebsiteVisitDependencies = {}): Promise<void> {
	const { submissionId, trigger, fromStatus } = readPayload(job.payload);
	const submission = await SubmissionsEntity.get(submissionId);
	if (!isWebsiteCase(submission)) return;
	if (submission.status === "running") {
		await failInterruptedVisit(submission);
		return;
	}
	let options: AnalyzeWebsiteOptions;
	if (trigger === "automatic") {
		if (submission.status !== "failed") return;
		try {
			await getRetryableSubmission(submission.id, "website");
			await claimRetry(submission, "automatic");
		} catch (error) {
			if (!(error instanceof SubmissionRetryError)) throw error;
			await dropAutomaticRetry(submission, error);
			return;
		}
		options = await retryAnalysisOptions(submission, "failed");
	} else {
		if (submission.status !== "queued") return;
		options = trigger === "manual" ? await retryAnalysisOptions(submission, fromStatus) : await initialAnalysisOptions(submission);
	}
	const analyze = dependencies.analyzeWebsite ?? analyzeWebsite;
	await analyze(options, dependencies.signal ? { signal: dependencies.signal } : {});
}

/**
 * Give every website case that waits for a visit its job, on start: a case
 * queued or running without one (it was opened before the queue existed, or
 * its process died between the insert and the enqueue), and a failed case
 * whose automatic retry is scheduled. Running cases are visited again as cut
 * off. Idempotent; returns how many jobs it queued.
 */
export async function ensureWebsiteVisitJobs(): Promise<number> {
	const db = await getDb();
	let queued = 0;
	for (const submission of await SubmissionsEntity.listAwaitingWebsiteVisits()) {
		if (!isWebsiteCase(submission) || activeJobByDedupeKey(db, visitJobKey(submission.id))) continue;
		const autoRetryAt = submission.data.website.autoRetry?.nextAttemptAt;
		if (submission.status === "failed") {
			if (!autoRetryAt) continue;
			await enqueueWebsiteVisit({ submission, trigger: "automatic", notBefore: new Date(autoRetryAt) });
		} else {
			await enqueueWebsiteVisit({ submission, trigger: "initial" });
		}
		queued++;
	}
	return queued;
}
