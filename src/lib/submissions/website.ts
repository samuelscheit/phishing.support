import { ArtifactsEntity } from "@/lib/db/entities/artifacts";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import { generateId } from "@/lib/db/ids";
import { analyzeWebsite, type AnalyzeWebsiteOptions } from "@/lib/website/analysis/ai";
import type { ReporterMetadata } from "@/lib/http/reporter_headers";
import { websiteSite } from "@/lib/website/info/site";
import { analyzedPage, latestArtifactNamed, navigationToPage, websiteCaptureFileNames } from "@/lib/website/visit/capture_files";
import { getRetryableSubmission, SubmissionRetryError } from "./retry";

export { SubmissionRetryError } from "./retry";

export type WebsiteSubmissionOptions = ReporterMetadata
	& Pick<AnalyzeWebsiteOptions, "url" | "mhtmlSnapshot" | "archivedUrl" | "navigationHops" | "screenshotSnapshot" | "captureRoute" | "verificationGate" | "kitResources" | "hiddenFrames" | "device">
	& {
		source?: string;
		/**
		 * Opens a separate case for another visit of a site that already has
		 * one, named by this key (a redirector watch's daily check). Without it
		 * a site has one case.
		 */
		visit?: string;
		/**
		 * Opens a fresh case even when the site already has one, analyzed and
		 * reported on its own (a reporter re-reporting a site by hand).
		 */
		rereport?: boolean;
	};

const AUTO_RETRY_POLL_MS = 60_000;

/**
 * Re-queue failed analyses whose automatic retry (a browser-service failure,
 * or a flow step not seen in that visit) has waited out its backoff. They go
 * through the normal retry boundary, so a case that has
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
			// A case the retry boundary refuses (reported, or retried by hand) is never
			// due again; left scheduled, it would take a sweep slot on every pass.
			const submission = await SubmissionsEntity.get(id);
			if (submission?.data.kind === "website" && submission.status === "failed" && submission.data.website.autoRetry) {
				await SubmissionsEntity.update(id, { data: { kind: "website", website: { ...submission.data.website, autoRetry: undefined } } });
			}
		}
	}
	return started;
}

/** Poll for due automatic retries until the returned stop function is called. */
export function startWebsiteAutoRetries(): () => void {
	const timer = setInterval(() => {
		void runDueWebsiteAutoRetries().then((started) => {
			if (started > 0) console.warn(`Automatically retried ${started} website analyses.`);
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

/**
 * One case per site; tenants of a shared host such as sites.google.com are
 * separate sites. A named visit of the site is a case of its own:
 * `website-<site>#<visit>`.
 */
export function websiteSubmissionDedupeKey(url: string, visit?: string): string {
	return `website-${websiteSite(url)}${visit ? `#${visit}` : ""}`;
}

export async function createWebsiteSubmission(
	options: WebsiteSubmissionOptions,
	startAnalysis: (options: AnalyzeWebsiteOptions) => Promise<unknown> = analyzeWebsite,
): Promise<bigint> {
	const streamId = generateId();
	const url = websiteSubmissionUrl(options.url);
	const { source, visit, rereport, ...analysisOptions } = options;

	const existingId = await SubmissionsEntity.create({
		kind: "website",
		data: { kind: "website", website: { url } },
		dedupeKey: websiteSubmissionDedupeKey(url, rereport ? `rereport-${streamId.toString()}` : visit),
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

	startAnalysis({ submissionId: streamId, ...analysisOptions, url }).catch(console.error);

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

	// The page the verdict rested on, with the chain as it stood when it was shown.
	const websiteData = submission.data.kind === "website" ? submission.data.website : undefined;
	const analyzed = websiteData ? analyzedPage(websiteData) : undefined;
	const artifactList = await ArtifactsEntity.listForSubmission(submissionId);
	const names = websiteCaptureFileNames(analyzed?.step ?? 0);
	const mhtmlArtifact = latestArtifactNamed(artifactList, names.mhtml);
	const screenshotArtifact = latestArtifactNamed(artifactList, names.screenshot);

	let mhtmlSnapshot: Buffer | undefined;
	let screenshotSnapshot: Buffer | undefined;
	// A cloaked capture holds only the decoy, and an unfinished flow only the
	// page before the step it could not take, often a one-time gate URL that no
	// longer loads; a retry must visit the site again from the submitted URL.
	const retainedArchiveHasTrustedProvenance = Boolean(
		websiteData
		&& analyzed
		&& websiteData.cloaking?.outcome !== "unresolved"
		&& !websiteData.unfinishedFlow,
	);
	if (mhtmlArtifact && retainedArchiveHasTrustedProvenance) {
		const artifact = await ArtifactsEntity.get(mhtmlArtifact.id);
		if (artifact?.blob?.byteLength) mhtmlSnapshot = artifact.blob;
	}
	if (screenshotArtifact && retainedArchiveHasTrustedProvenance) {
		const artifact = await ArtifactsEntity.get(screenshotArtifact.id);
		if (artifact?.blob?.byteLength) screenshotSnapshot = artifact.blob;
	}

	const claimed = await SubmissionsEntity.transitionStatus(submissionId, "failed", "running");
	if (!claimed) throw new SubmissionRetryError("This submission is already being retried.");

	void startAnalysis({
		submissionId,
		url,
		mhtmlSnapshot,
		archivedUrl: analyzed?.hop.url,
		navigationHops: analyzed ? navigationToPage(websiteData!.navigationHops!, analyzed.hop) : undefined,
		trustMhtmlDocumentLocation: Boolean(mhtmlSnapshot),
		verificationGate: mhtmlSnapshot ? websiteData?.verificationGate : undefined,
		kitResources: mhtmlSnapshot ? websiteData?.kitResources : undefined,
		hiddenFrames: mhtmlSnapshot ? websiteData?.hiddenFrames : undefined,
		device: mhtmlSnapshot ? websiteData?.device : undefined,
		screenshotSnapshot,
		reporterIp: submission.reporterIp ?? undefined,
		reporterCountry: submission.reporterCountry ?? undefined,
		reporterHeaders: submission.reporterHeaders ?? undefined,
		reuseEvidenceArtifacts: Boolean(mhtmlSnapshot && screenshotArtifact && retainedArchiveHasTrustedProvenance),
	}).catch((error) => {
		console.error("Retried website analysis failed:", error);
	});
}
