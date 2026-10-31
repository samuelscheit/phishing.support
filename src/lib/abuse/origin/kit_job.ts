import { SubmissionsEntity } from "../../db/entities";
import { createWebsiteSubmission } from "../../submissions/website";
import { analyzeWebsite } from "../../website_ai";
import { normalizeDomain, normalizePublicHttpUrl } from "../security";
import { AbuseRepository } from "../repository";
import { throwIfAborted } from "../worker/shared";
import { findKitSiblingCandidates, type KitSiblingSearchResult } from "./siblings";

export type KitSiblingJobDependencies = {
	findCandidates?: typeof findKitSiblingCandidates;
};

export type KitSiblingAnalysisDependencies = {
	analyzeWebsite?: typeof analyzeWebsite;
};

/** Submission sources created by kit discovery itself; they never seed another round. */
const SIBLING_SOURCE = /^(?:kit|origin)-sibling:/;
/** A redirect hand-off opens the destination's own case; it inherits its parent's lineage. */
const REDIRECT_SOURCE = /^redirect:(\d{1,20})$/;
const MAX_REDIRECT_LINEAGE = 5;
const KIT_SEED_BASES = new Set(["credential_theft", "payment_fraud"]);

/**
 * Only a page our classifier confirmed as a credential or payment kit may seed
 * a search, and never a site that was itself found by one. Without this a
 * search from a sibling found its own siblings, and every shared file pulled
 * in more unrelated sites.
 */
export async function isKitSiblingSeed(submissionId: bigint): Promise<boolean> {
	const submission = await SubmissionsEntity.get(submissionId);
	if (submission?.data.kind !== "website" || await discoveredBySiblingSearch(submission.source)) return false;
	return (submission.data.website.siteAssessments ?? []).some(({ finding, phishingBasis }) => finding === "phishing" && KIT_SEED_BASES.has(phishingBasis ?? ""));
}

async function discoveredBySiblingSearch(source: string | null | undefined): Promise<boolean> {
	let current = source ?? "";
	for (let depth = 0; depth <= MAX_REDIRECT_LINEAGE; depth++) {
		if (SIBLING_SOURCE.test(current)) return true;
		const parent = REDIRECT_SOURCE.exec(current)?.[1];
		if (!parent) return false;
		current = (await SubmissionsEntity.get(BigInt(parent)))?.source ?? "";
	}
	// An implausibly long redirect chain is not trusted as an original report.
	return true;
}

export async function enqueueKitSiblingDiscovery(reportId: bigint, submissionId: bigint): Promise<void> {
	if (!await isKitSiblingSeed(submissionId)) return;
	await AbuseRepository.enqueueJobOnce({
		jobType: "discover_kit_siblings",
		reportId,
		payload: { submissionId: submissionId.toString() },
		dedupeKey: `discover-kit-siblings:${reportId.toString()}`,
	});
}

/** Search urlscan for a confirmed kit; normal analysis decides whether candidates are reportable. */
export async function discoverKitSiblings(
	params: { reportId: bigint; signal?: AbortSignal },
	dependencies: KitSiblingJobDependencies = {},
): Promise<KitSiblingSearchResult> {
	const report = await AbuseRepository.getReport(params.reportId);
	if (!report?.submissionId || !await isKitSiblingSeed(report.submissionId)) return { fingerprints: [], candidates: [], errors: [] };
	const targets = await AbuseRepository.listTargets(report.id);
	const originalDomain = targets.map(({ normalizedTarget, targetType }) => targetType === "domain" ? normalizeDomain(normalizedTarget) : undefined)
		.find((domain): domain is string => Boolean(domain));
	if (!originalDomain) return { fingerprints: [], candidates: [], errors: ["Website report has no domain target."] };
	throwIfAborted(params.signal);
	const result = await (dependencies.findCandidates ?? findKitSiblingCandidates)({
		submissionId: report.submissionId,
		originalDomain,
		signal: params.signal,
	});
	for (const [index, candidate] of result.candidates.entries()) {
		throwIfAborted(params.signal);
		await AbuseRepository.enqueueJobOnce({
			jobType: "analyze_kit_sibling",
			reportId: report.id,
			payload: { url: candidate.url },
			dedupeKey: `analyze-kit-sibling:${report.id.toString()}:${candidate.domain}`,
			nextAttemptAt: new Date(Date.now() + index * 30_000),
		});
	}
	if (result.errors.length) console.warn(`Kit sibling discovery for report ${report.id.toString()} completed with warnings: ${result.errors.join("; ")}`);
	return result;
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
