import { SubmissionsEntity } from "../db/entities";
import type { WebsiteSubmissionData } from "../db/schema";
import { errorSummary } from "../error_text";
import { isUrlscanBusy, searchUrlscan, urlscanDom, urlscanResponses, type UrlscanDependencies } from "../abuse/origin/urlscan";
import { capturedDocumentContent } from "../website_archive";
import { analyzedCaptureStep, websiteCaptureFileNames } from "../website_capture_files";
import type { WebsiteKitResource } from "../website_types";
import { loadCapturedPageTexts } from "./indicators";
import { DAY_MS } from "../duration";

/**
 * Kit files for a site captured before captures recorded them. The capture
 * kept the page (MHTML has no scripts), so urlscan.io's scans of the same
 * site are read instead, and a scan counts only when the page it saw reads
 * like ours: a site that went down, was parked or replaced since shows
 * other files, and those would link unrelated sites.
 */

/** Scans of the site read, newest first; urlscan's search reaches back a few months. */
const MAX_SCANS = 10;
/** Share of our page's word triples a scan's page must show to be the same page. */
const MIN_TEXT_MATCH = 0.6;
/** A page with fewer word triples than this is too short to tell apart from another. */
const MIN_SHINGLES = 20;
/** A site urlscan had nothing for is asked again after this long: new scans may have appeared. */
const RECHECK_AFTER_MS = 30 * DAY_MS;
const KIT_TYPES = new Set(["script", "stylesheet"]);

export type KitBackfillDependencies = UrlscanDependencies & {
	loadPageTexts?: typeof loadCapturedPageTexts;
	now?: () => Date;
};

export type KitBackfillOutcome =
	| { kind: "not_needed" }
	| { kind: "recently_checked" }
	| { kind: "matched"; scanId: string; resources: number; textMatch: number }
	| { kind: "no_match"; scans: number; reason: string };

function shingles(text: string): Set<string> {
	const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	const set = new Set<string>();
	for (let index = 0; index + 3 <= words.length; index++) set.add(words.slice(index, index + 3).join(" "));
	return set;
}

/** How much of our page's text the other page shows: the share of our word triples it contains. */
export function textMatch(ours: string, theirs: string): number {
	const mine = shingles(ours);
	if (mine.size < MIN_SHINGLES) return 0;
	const other = shingles(theirs);
	let shared = 0;
	for (const shingle of mine) if (other.has(shingle)) shared++;
	return shared / mine.size;
}

/**
 * Fill in the kit files of a reported site whose capture recorded none, from
 * the urlscan scan whose page matches our analyzed page best. What urlscan
 * was asked and found is kept on the submission, so a sweep does not ask
 * again until new scans may exist. urlscan being busy throws and records
 * nothing: no scan was read, so none can be said not to match.
 */
export async function backfillKitResources(submissionId: bigint, dependencies: KitBackfillDependencies = {}): Promise<KitBackfillOutcome> {
	const submission = await SubmissionsEntity.get(submissionId);
	if (submission?.data.kind !== "website") return { kind: "not_needed" };
	const website = submission.data.website;
	if (website.kitResources?.length || website.urlscanKit?.scan) return { kind: "not_needed" };
	const now = (dependencies.now ?? (() => new Date()))();
	if (website.urlscanKit && now.getTime() - Date.parse(website.urlscanKit.checkedAt) < RECHECK_AFTER_MS) return { kind: "recently_checked" };

	const save = (urlscanKit: NonNullable<WebsiteSubmissionData["urlscanKit"]>) => SubmissionsEntity.setWebsiteField(submissionId, "urlscanKit", urlscanKit);
	// The page the case was judged on: an earlier step (a gate, a host's own interstitial) could match unrelated scans.
	const analyzed = websiteCaptureFileNames(analyzedCaptureStep(website.navigationHops)).mhtml;
	const ours = (await (dependencies.loadPageTexts ?? loadCapturedPageTexts)(submissionId)).find(({ name }) => name === analyzed)?.text;
	const checkedAt = now.toISOString();
	// Without our page's text no scan can be told to show it.
	if (!ours) {
		await save({ checkedAt, resources: [] });
		return { kind: "no_match", scans: 0, reason: "our capture has no readable page" };
	}
	const host = new URL(website.archiveUrl ?? website.url).hostname;
	const found = await searchUrlscan(`page.domain:"${host}"`, MAX_SCANS, dependencies);
	let best: { id: string; url: string; scannedAt: string; textMatch: number } | undefined;
	for (const scan of found.results) {
		if (!scan._id) continue;
		let match = 0;
		try {
			match = textMatch(ours, capturedDocumentContent(await urlscanDom(scan._id, dependencies)).text);
		} catch (error) {
			if (isUrlscanBusy(error)) throw error;
			console.warn(`urlscan scan ${scan._id} of ${host} could not be read: ${errorSummary(error)}`);
			continue;
		}
		if (match >= MIN_TEXT_MATCH && match > (best?.textMatch ?? 0)) {
			best = { id: scan._id, url: scan.page?.url ?? scan.task?.url ?? `https://${host}/`, scannedAt: scan.task?.time ?? "", textMatch: Math.round(match * 100) / 100 };
		}
	}
	if (!best) {
		await save({ checkedAt, resources: [] });
		return { kind: "no_match", scans: found.results.length, reason: found.results.length ? "no scan showed our page" : "urlscan has no recent scan of the site" };
	}
	const resources: WebsiteKitResource[] = (await urlscanResponses(best.id, dependencies))
		.filter((response) => KIT_TYPES.has(response.type) && response.status === 200 && response.size > 0)
		.map(({ url, type, mimeType, sha256, size }) => ({ url, mimeType: mimeType || type, sha256, size }));
	await save({ checkedAt, scan: best, resources });
	return { kind: "matched", scanId: best.id, resources: resources.length, textMatch: best.textMatch };
}
