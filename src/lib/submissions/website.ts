import { ArtifactsEntity } from "@/lib/db/entities/artifacts";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import { generateId } from "@/lib/db/ids";
import type { AnalyzeWebsiteOptions } from "@/lib/website/analysis/ai";
import type { ReporterMetadata } from "@/lib/http/reporter_headers";
import { websiteSite } from "@/lib/website/info/site";
import type { SubmissionStatus } from "@/lib/db/schema";
import { enqueueWebsiteVisit, REPORTER_MHTML_NAME } from "@/lib/website/visit_queue/queue";
import { claimRetry, getRetryableSubmission, SubmissionRetryError } from "./retry";
import type { ReporterInstructions } from "./instructions";

export { SubmissionRetryError } from "./retry";

export type WebsiteSubmissionOptions = ReporterMetadata
	& Pick<AnalyzeWebsiteOptions, "url" | "instructions" | "mhtmlSnapshot">
	& {
		source?: string;
		/** The share its visit counts against: the case's that caused it (a kit, origin or redirector sibling's parent). */
		fairKey?: string;
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

/** A website case as `createWebsiteSubmission` left it: new and queued, or the site's existing case. */
export type WebsiteSubmission = { id: bigint; status: SubmissionStatus };

/**
 * Open a website case and queue its visit, or return the site's existing
 * case. The visit runs when the visit queue gets to it (website/visit_queue),
 * never at once: a reporter's flood of URLs waits its share instead of
 * starting a browser per URL.
 */
export async function createWebsiteSubmission(options: WebsiteSubmissionOptions): Promise<WebsiteSubmission> {
	const id = generateId();
	const url = websiteSubmissionUrl(options.url);
	const { source, visit, rereport, fairKey, mhtmlSnapshot, instructions, reporterIp, reporterCountry, reporterHeaders } = options;
	const caseSource = source || options.url;

	const existingId = await SubmissionsEntity.create({
		kind: "website",
		data: { kind: "website", website: { url, ...(instructions ? { instructions } : {}) } },
		dedupeKey: websiteSubmissionDedupeKey(url, rereport ? `rereport-${id.toString()}` : visit),
		status: "queued",
		source: caseSource,
		reporterIp,
		reporterCountry,
		reporterHeaders,
		id,
	});
	if (existingId !== id) {
		const existing = await SubmissionsEntity.get(existingId);
		return { id: existingId, status: existing?.status ?? "queued" };
	}

	if (mhtmlSnapshot?.byteLength) {
		await ArtifactsEntity.saveBuffer({ submissionId: id, kind: "mhtml", name: REPORTER_MHTML_NAME, mimeType: "multipart/related", buffer: mhtmlSnapshot });
	}
	await enqueueWebsiteVisit({ submission: { id, reporterIp: reporterIp ?? null, source: caseSource }, trigger: "initial", fairKey });
	return { id, status: "queued" };
}

/**
 * Retry a failed or unreported website case by hand: claimed at once (the
 * cooldown and the race are decided here), visited when the queue gets to it.
 */
export async function retryWebsiteAnalysis(
	submissionId: bigint,
	replacement: {
		/**
		 * The reporter's instructions this retry replaces the stored ones with,
		 * `undefined` to clear them; without the key the stored ones are kept.
		 */
		instructions?: ReporterInstructions;
	} = {},
): Promise<void> {
	const { submission } = await getRetryableSubmission(submissionId, "website");
	const websiteData = submission.data.kind === "website" ? submission.data.website : undefined;
	if (!websiteData?.url) throw new SubmissionRetryError("The original website URL is unavailable.");

	await claimRetry(submission, "manual", { to: "queued" });
	if ("instructions" in replacement) {
		const { instructions } = replacement;
		await SubmissionsEntity.update(submissionId, { data: { kind: "website", website: { ...websiteData, instructions } } });
	}
	await enqueueWebsiteVisit({ submission, trigger: "manual", fromStatus: submission.status });
}
