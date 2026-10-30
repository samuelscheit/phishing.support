import { createWebsiteSubmission, type WebsiteSubmissionOptions } from "../../submissions/website";
import { normalizeDomain, normalizePublicHttpUrl } from "../security";
import { AbuseRepository } from "../repository";
import { throwIfAborted } from "../worker/shared";
import { findKitSiblingCandidates, type KitSiblingSearchResult } from "./siblings";

export type KitSiblingJobDependencies = {
	findCandidates?: typeof findKitSiblingCandidates;
};

export type KitSiblingAnalysisDependencies = {
	createSubmission?: (options: WebsiteSubmissionOptions) => Promise<bigint>;
};

export async function enqueueKitSiblingDiscovery(reportId: bigint, submissionId: bigint, nextAttemptAt?: Date): Promise<void> {
	await AbuseRepository.enqueueJobOnce({
		jobType: "discover_kit_siblings",
		reportId,
		payload: { submissionId: submissionId.toString() },
		dedupeKey: `discover-kit-siblings:${reportId.toString()}`,
		...(nextAttemptAt ? { nextAttemptAt } : {}),
	});
}

/** Ensure reports created before kit discovery existed receive the same durable job. */
export async function ensureKitSiblingDiscoveryJobs(): Promise<number> {
	let reports = 0;
	for (const [index, { reportId, submissionId }] of (await AbuseRepository.listWebsiteReports()).entries()) {
		// Five bounded searches can be issued by one case. Spacing historical
		// cases keeps startup backfill below urlscan's documented quota windows.
		await enqueueKitSiblingDiscovery(reportId, submissionId, new Date(Date.now() + index * 20_000));
		reports++;
	}
	return reports;
}

/** Search urlscan for every confirmed website case; normal analysis decides whether candidates are reportable. */
export async function discoverKitSiblings(
	params: { reportId: bigint; signal?: AbortSignal },
	dependencies: KitSiblingJobDependencies = {},
): Promise<KitSiblingSearchResult> {
	const report = await AbuseRepository.getReport(params.reportId);
	if (!report?.submissionId) return { fingerprints: [], candidates: [], errors: [] };
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

/** Start one normal analysis at a paced durable boundary. */
export async function analyzeKitSibling(
	params: { reportId: bigint; url: unknown; signal?: AbortSignal },
	dependencies: KitSiblingAnalysisDependencies = {},
): Promise<bigint | undefined> {
	const report = await AbuseRepository.getReport(params.reportId);
	if (!report?.submissionId || typeof params.url !== "string") return undefined;
	const url = normalizePublicHttpUrl(params.url);
	if (!url) throw new Error("Kit sibling job contains an invalid public URL.");
	throwIfAborted(params.signal);
	return (dependencies.createSubmission ?? createWebsiteSubmission)({
		url,
		source: `kit-sibling:${report.submissionId.toString()}:${report.id.toString()}`,
		reporterIp: report.requesterIp ?? undefined,
		reporterCountry: report.requesterCountry ?? undefined,
		reporterHeaders: report.requesterHeaders ?? undefined,
	});
}
