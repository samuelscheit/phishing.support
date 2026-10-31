import { ArtifactsEntity, SubmissionsEntity } from "@/lib/db/entities";
import { generateId } from "@/lib/db/ids";
import { analyzeWebsite, type AnalyzeWebsiteOptions } from "@/lib/website_ai";
import type { ReporterMetadata } from "@/lib/request_metadata";
import { websiteSite } from "@/lib/website_site";
import { getRetryableSubmission, SubmissionRetryError } from "./retry";

export { SubmissionRetryError } from "./retry";

export type WebsiteSubmissionOptions = ReporterMetadata
	& Pick<AnalyzeWebsiteOptions, "url" | "mhtmlSnapshot" | "archivedUrl" | "navigationHops" | "screenshotSnapshot" | "captureRoute" | "verificationGate" | "kitResources">
	& { source?: string };

type WebsiteAnalysisRecoveryOptions = ReporterMetadata & {
	submissionId: bigint;
	url: string;
};

/**
 * Resume the small legacy window where a website submission was inserted as
 * `new` before its detached analyzer actually began.  This is intentionally
 * recovery-only: active/running rows are still failed on restart, preserving
 * the explicit retry boundary for work that could have reached a later stage.
 */
export async function resumePendingWebsiteAnalyses(params: {
	limit?: number;
	startAnalysis?: (options: WebsiteAnalysisRecoveryOptions) => Promise<unknown>;
} = {}): Promise<number> {
	const pending = await SubmissionsEntity.listPendingWebsiteAnalyses(params.limit);
	const startAnalysis = params.startAnalysis ?? analyzeWebsite;
	let resumed = 0;

	for (const submission of pending) {
		const url = submission.data.kind === "website" ? submission.data.website?.url : undefined;
		const claimed = await SubmissionsEntity.claimPendingWebsiteAnalysis(submission.id);
		if (!claimed) continue;
		if (!url) {
			await SubmissionsEntity.update(submission.id, { status: "failed", info: "Website analysis could not resume because the original URL is unavailable." });
			continue;
		}
		resumed++;
		void startAnalysis({
			submissionId: submission.id,
			url,
			reporterIp: submission.reporterIp ?? undefined,
			reporterCountry: submission.reporterCountry ?? undefined,
			reporterHeaders: submission.reporterHeaders ?? undefined,
		}).catch((error) => console.error(`Resumed website analysis ${submission.id.toString()} failed:`, error));
	}

	return resumed;
}

const AUTO_RETRY_POLL_MS = 60_000;

/**
 * Re-queue failed analyses whose browser-service failure has waited out its
 * backoff. They go through the normal retry boundary, so a case that has
 * since been reported or retried by hand is left alone.
 */
export async function runDueWebsiteAutoRetries(params: {
	now?: Date;
	startAnalysis?: (options: AnalyzeWebsiteOptions) => Promise<unknown>;
} = {}): Promise<number> {
	let started = 0;
	for (const { id } of await SubmissionsEntity.listDueWebsiteAutoRetries(params.now ?? new Date())) {
		try {
			await retryFailedWebsiteAnalysis(id, params.startAnalysis);
			started++;
		} catch (error) {
			if (!(error instanceof SubmissionRetryError)) throw error;
			console.warn(`Automatic retry of website analysis ${id.toString()} skipped: ${error.message}`);
		}
	}
	return started;
}

/** Poll for due automatic retries until the returned stop function is called. */
export function startWebsiteAutoRetries(): () => void {
	const timer = setInterval(() => {
		void runDueWebsiteAutoRetries().then((started) => {
			if (started > 0) console.warn(`Automatically retried ${started} website analyses after browser-service failures.`);
		}).catch((error) => console.error("Automatic website analysis retry failed:", error));
	}, AUTO_RETRY_POLL_MS);
	timer.unref?.();
	return () => clearInterval(timer);
}

/**
 * The address of the site a submitted URL points at. Kits that swap their page
 * in from a script leave a `blob:` URL in the address bar, which a reporter may
 * copy; it exists only inside that one browser tab, and its origin is the site
 * that served it.
 */
export function websiteSubmissionUrl(url: string): string {
	const parsed = new URL(url.trim());
	if (parsed.protocol === "blob:") return new URL(parsed.pathname).origin + "/";
	return parsed.toString();
}

/** One case per site; tenants of a shared host such as sites.google.com are separate sites. */
export function websiteSubmissionDedupeKey(url: string): string {
	return `website-${websiteSite(url)}`;
}

export async function createWebsiteSubmission(
	options: WebsiteSubmissionOptions,
	startAnalysis: (options: AnalyzeWebsiteOptions) => Promise<unknown> = analyzeWebsite,
): Promise<bigint> {
	const streamId = generateId();
	const url = websiteSubmissionUrl(options.url);
	const { source } = options;

	const existingId = await SubmissionsEntity.create({
		kind: "website",
		data: { kind: "website", website: { url } },
		dedupeKey: websiteSubmissionDedupeKey(url),
		// The worker starts immediately after insertion. Mark it running at the
		// durable boundary so a process restart cannot leave a submission looking
		// perpetually new while its first WHOIS lookup is in flight.
		status: "running",
		source: source || options.url,
		reporterIp: options.reporterIp,
		reporterCountry: options.reporterCountry,
		reporterHeaders: options.reporterHeaders,
		id: streamId,
	});

	if (existingId !== streamId) return existingId;

	startAnalysis({ submissionId: streamId, ...options, url }).catch(console.error);

	return streamId;
}

/**
 * Re-run a failed website analysis without creating a second submission. When
 * the first attempt captured an MHTML archive, it is supplied to the retry so
 * a transient model failure cannot cause the site to be fetched again after it
 * has changed or started redirecting scanners.
 */
export async function retryFailedWebsiteAnalysis(
	submissionId: bigint,
	startAnalysis: (options: AnalyzeWebsiteOptions) => Promise<unknown> = analyzeWebsite,
): Promise<void> {
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
	let screenshotSnapshot: Buffer | undefined;
	// A cloaked capture holds only the decoy; a retry must visit the site again.
	const retainedArchiveHasTrustedProvenance = Boolean(
		submission.data.kind === "website"
		&& submission.data.website.archiveUrl
		&& submission.data.website.navigationHops?.length
		&& submission.data.website.cloaking?.outcome !== "unresolved",
	);
	if (mhtmlArtifact && retainedArchiveHasTrustedProvenance) {
		const artifact = await ArtifactsEntity.get(mhtmlArtifact.id);
		if (artifact?.blob?.byteLength) mhtmlSnapshot = artifact.blob;
	}
	if (screenshotArtifact && retainedArchiveHasTrustedProvenance) {
		const artifact = await ArtifactsEntity.get(screenshotArtifact.id);
		if (artifact?.blob?.byteLength) screenshotSnapshot = artifact.blob;
	}

	const claimed = await SubmissionsEntity.transitionStatus(submissionId, "failed", "queued");
	if (!claimed) throw new SubmissionRetryError("This submission is already being retried.");

	const websiteData = submission.data.kind === "website" ? submission.data.website : undefined;
	void startAnalysis({
		submissionId,
		url,
		mhtmlSnapshot,
		archivedUrl: websiteData?.archiveUrl,
		navigationHops: websiteData?.navigationHops,
		trustMhtmlDocumentLocation: Boolean(mhtmlSnapshot),
		verificationGate: mhtmlSnapshot ? websiteData?.verificationGate : undefined,
		kitResources: mhtmlSnapshot ? websiteData?.kitResources : undefined,
		screenshotSnapshot,
		reporterIp: submission.reporterIp ?? undefined,
		reporterCountry: submission.reporterCountry ?? undefined,
		reporterHeaders: submission.reporterHeaders ?? undefined,
		reuseEvidenceArtifacts: Boolean(mhtmlSnapshot && screenshotArtifact && retainedArchiveHasTrustedProvenance),
	}).catch((error) => {
		console.error("Retried website analysis failed:", error);
	});
}
