import { SubmissionsEntity } from "../../db/entities/submissions";
import { createWebsiteSubmission, websiteSubmissionDedupeKey } from "../../submissions/website";
import { analyzeWebsite } from "../../website/analysis/ai";
import { normalizePublicHttpUrl } from "../security/security";
import { AbuseRepository } from "../repository";
import { throwIfAborted } from "../worker/shared";

export type KitSiblingAnalysisDependencies = {
	analyzeWebsite?: typeof analyzeWebsite;
};

/** Submission sources created by kit discovery itself; they never seed another round. */
const SIBLING_SOURCE = /^(?:kit|origin)-sibling:/;
/** Findings whose kit is worth finding elsewhere: a credential or payment kit, or a malware kit such as an exploit loader. */
const SEED_FINDINGS = new Set(["phishing", "malware"]);

/**
 * Only a page our classifier confirmed as a phishing or malware kit may seed
 * a search, and never a site that was itself found by one. Without this a
 * search from a sibling found its own siblings, and every shared file pulled
 * in more unrelated sites.
 */
export async function isKitSiblingSeed(submissionId: bigint): Promise<boolean> {
	const submission = await SubmissionsEntity.get(submissionId);
	if (submission?.data.kind !== "website" || SIBLING_SOURCE.test(submission.source ?? "")) return false;
	return (submission.data.website.siteAssessments ?? []).some(({ finding }) => SEED_FINDINGS.has(finding));
}

/**
 * Sites a kit file found that the analysis judged harmless, with none
 * confirmed, after which the file is retired: it is a platform's or a
 * framework's (a Next.js chunk on two dozen unrelated sites), not a kit's.
 * A kit's own file finds some sites already taken down or cloaked, so it
 * takes several harmless ones in a row; a single confirmed site keeps it.
 */
const RETIRE_AFTER_HARMLESS = 8;

/** Of these kit files, those whose found sites so far were all harmless (`RETIRE_AFTER_HARMLESS`). */
export async function retiredKitHashes(hashes: readonly string[]): Promise<Set<string>> {
	const retired = new Set<string>();
	for (const hash of new Set(hashes)) {
		let harmless = 0;
		let confirmed = false;
		for (const url of await AbuseRepository.listKitSiblingAnalysisUrls(hash)) {
			const id = await SubmissionsEntity.findIdByDedupeKey(websiteSubmissionDedupeKey(url));
			const status = id === undefined ? undefined : (await SubmissionsEntity.get(id))?.status;
			if (status === "reported") {
				confirmed = true;
				break;
			}
			if (status === "invalid") harmless += 1;
		}
		if (!confirmed && harmless >= RETIRE_AFTER_HARMLESS) retired.add(hash);
	}
	return retired;
}

/**
 * Run one normal analysis inside this job. Waiting for it keeps sibling
 * captures inside the worker lane's concurrency; a detached analysis let
 * dozens of browser captures start at once and exhaust the relay. A site
 * found only through kit files retired since it was queued is not opened.
 */
export async function analyzeKitSibling(
	params: { reportId: bigint; url: unknown; hashes?: unknown; signal?: AbortSignal },
	dependencies: KitSiblingAnalysisDependencies = {},
): Promise<bigint | undefined> {
	const report = await AbuseRepository.getReport(params.reportId);
	if (!report?.submissionId || typeof params.url !== "string") return undefined;
	const url = normalizePublicHttpUrl(params.url);
	if (!url) throw new Error("Kit sibling job contains an invalid public URL.");
	const hashes = Array.isArray(params.hashes) ? params.hashes.filter((hash): hash is string => typeof hash === "string") : [];
	if (hashes.length) {
		const retired = await retiredKitHashes(hashes);
		if (hashes.every((hash) => retired.has(hash))) {
			await AbuseRepository.appendEvent({ reportId: report.id, eventType: "kit_siblings.skipped", data: { url, retiredHashes: hashes } });
			return undefined;
		}
	}
	throwIfAborted(params.signal);
	let analysis: Promise<unknown> | undefined;
	const submissionId = await createWebsiteSubmission({
		url,
		source: `kit-sibling:${report.submissionId.toString()}:${report.id.toString()}`,
		reporterIp: report.requesterIp ?? undefined,
		reporterCountry: report.requesterCountry ?? undefined,
		reporterHeaders: report.requesterHeaders ?? undefined,
	}, (options) => (analysis = (dependencies.analyzeWebsite ?? analyzeWebsite)(options)));
	await analysis;
	return submissionId;
}
