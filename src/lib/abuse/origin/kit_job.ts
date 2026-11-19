import { SubmissionsEntity } from "../../db/entities";
import { createWebsiteSubmission } from "../../submissions/website";
import { analyzeWebsite } from "../../website_ai";
import { normalizePublicHttpUrl } from "../security";
import { AbuseRepository } from "../repository";
import { throwIfAborted } from "../worker/shared";

export type KitSiblingAnalysisDependencies = {
	analyzeWebsite?: typeof analyzeWebsite;
};

/** Submission sources created by kit discovery itself; they never seed another round. */
const SIBLING_SOURCE = /^(?:kit|origin)-sibling:/;
/** A redirect hand-off opens the destination's own case; it inherits its parent's lineage. */
const REDIRECT_SOURCE = /^redirect:(\d{1,20})$/;
const MAX_REDIRECT_LINEAGE = 5;

/** The case a redirect hand-off came from, when `source` names one. */
export function redirectParentId(source: string | null | undefined): bigint | undefined {
	const parent = REDIRECT_SOURCE.exec(source ?? "")?.[1];
	return parent === undefined ? undefined : BigInt(parent);
}
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
	if (submission?.data.kind !== "website" || await discoveredBySiblingSearch(submission.source)) return false;
	return (submission.data.website.siteAssessments ?? []).some(({ finding }) => SEED_FINDINGS.has(finding));
}

async function discoveredBySiblingSearch(source: string | null | undefined): Promise<boolean> {
	let current = source ?? "";
	for (let depth = 0; depth <= MAX_REDIRECT_LINEAGE; depth++) {
		if (SIBLING_SOURCE.test(current)) return true;
		const parent = redirectParentId(current);
		if (parent === undefined) return false;
		current = (await SubmissionsEntity.get(parent))?.source ?? "";
	}
	// An implausibly long redirect chain is not trusted as an original report.
	return true;
}

/**
 * Run one normal analysis inside this job. Waiting for it keeps sibling
 * captures inside the worker lane's concurrency; a detached analysis let
 * dozens of browser captures start at once and exhaust the relay.
 */
export async function analyzeKitSibling(
	params: { reportId: bigint; url: unknown; signal?: AbortSignal },
	dependencies: KitSiblingAnalysisDependencies = {},
): Promise<bigint | undefined> {
	const report = await AbuseRepository.getReport(params.reportId);
	if (!report?.submissionId || typeof params.url !== "string") return undefined;
	const url = normalizePublicHttpUrl(params.url);
	if (!url) throw new Error("Kit sibling job contains an invalid public URL.");
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
