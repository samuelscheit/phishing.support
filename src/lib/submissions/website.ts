import { ArtifactsEntity, SubmissionsEntity } from "@/lib/db/entities";
import { generateId } from "@/lib/db/ids";
import { analyzeWebsite } from "@/lib/website_ai";
import type { ReporterMetadata } from "@/lib/request_metadata";
import { getRetryableSubmission, SubmissionRetryError } from "./retry";

export { SubmissionRetryError } from "./retry";

export type WebsiteSubmissionOptions = ReporterMetadata & {
	mhtmlSnapshot?: Buffer;
	url: string;
	source?: string;
};

export async function createWebsiteSubmission(options: WebsiteSubmissionOptions): Promise<bigint> {
	const streamId = generateId();
	const { url, source } = options;

	const existingId = await SubmissionsEntity.create({
		kind: "website",
		data: { kind: "website", website: { url } },
		dedupeKey: `website-${new URL(url).hostname}`,
		status: "new",
		source: source || url,
		reporterIp: options.reporterIp,
		reporterCountry: options.reporterCountry,
		reporterHeaders: options.reporterHeaders,
		id: streamId,
	});

	if (existingId !== streamId) return existingId;

	analyzeWebsite({ submissionId: streamId, ...options }).catch(console.error);

	return streamId;
}

/**
 * Re-run a failed website analysis without creating a second submission. When
 * the first attempt captured an MHTML archive, it is supplied to the retry so
 * a transient model failure cannot cause the site to be fetched again after it
 * has changed or started redirecting scanners.
 */
export async function retryFailedWebsiteAnalysis(submissionId: bigint): Promise<void> {
	const { submission } = await getRetryableSubmission(submissionId, "website", { allowCompletedPriorRuns: true });
	const url = submission.data.kind === "website" ? submission.data.website?.url : undefined;
	if (!url) throw new SubmissionRetryError("The original website URL is unavailable.");

	const artifactList = await ArtifactsEntity.listForSubmission(submissionId);
	const mhtmlArtifact = artifactList.find(
		(artifact) => artifact.kind === "website_mhtml" || artifact.mimeType?.toLowerCase() === "text/mhtml" || artifact.name?.toLowerCase() === "website.mhtml",
	);
	const screenshotArtifact = artifactList.find(
		(artifact) => artifact.kind === "website_png" || artifact.name?.toLowerCase() === "website.png",
	);

	let mhtmlSnapshot: Buffer | undefined;
	if (mhtmlArtifact) {
		const artifact = await ArtifactsEntity.get(mhtmlArtifact.id);
		if (artifact?.blob?.byteLength) mhtmlSnapshot = artifact.blob;
	}

	const claimed = await SubmissionsEntity.transitionStatus(submissionId, "failed", "queued");
	if (!claimed) throw new SubmissionRetryError("This submission is already being retried.");

	void analyzeWebsite({
		submissionId,
		url,
		mhtmlSnapshot,
		reporterIp: submission.reporterIp ?? undefined,
		reporterCountry: submission.reporterCountry ?? undefined,
		reporterHeaders: submission.reporterHeaders ?? undefined,
		reuseEvidenceArtifacts: Boolean(mhtmlSnapshot && screenshotArtifact),
	}).catch((error) => {
		console.error("Retried website analysis failed:", error);
	});
}
