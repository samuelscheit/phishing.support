import { discardQueuedJob, enqueueJobOnce, latestJobByDedupeKey } from "@/lib/abuse/persistence/jobs";
import { collectCaseIntoReport, getReportForSubmission, listTargets, releaseCollectedCase, siteGroupReport } from "@/lib/abuse/persistence/reports";
import { queueCaseSiteLinks } from "@/lib/campaign/queue";
import { CampaignRepository } from "@/lib/campaign/repository";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import type { Submission, WebsiteCollection, WebsiteSubmissionData } from "@/lib/db/schema";
import { verifyReportedContent } from "@/lib/liveness/content";
import { siteGroupOf } from "@/lib/network/registered_domain";
import { enqueueWebsiteVisit, visitJobKey } from "./queue";

/**
 * How many distinct hosts of a site group are visited before the group's
 * other hosts are left unvisited, when none of them showed a threat. Wildcard
 * subdomains serve one kit: one empty visit is often cloaking or a host that
 * is down, five in a row are the group's answer.
 */
export const SIBLING_TRIAL_LIMIT = 5;

export type WebsiteCase = Submission & { data: { kind: "website"; website: WebsiteSubmissionData } };

export function isWebsiteCase(submission: Submission | undefined): submission is WebsiteCase {
	return submission?.kind === "website" && submission.data.kind === "website";
}

/** A case of its own beside its site's (a re-report, a redirector watch's daily visit): it always visits. */
const isExtraVisit = (submission: Pick<Submission, "dedupeKey">) => submission.dedupeKey.includes("#");

/** The registrable domain a case's site group is, undefined for a platform tenant or an address. */
function groupDomain(submission: WebsiteCase): string | undefined {
	try {
		return siteGroupOf(submission.data.website.url).domain;
	} catch {
		return undefined;
	}
}

function hostOf(url: string): string | undefined {
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}

export type SiblingDecision =
	| { kind: "visit" }
	| { kind: "collect"; report: { reportId: bigint; submissionId: bigint } }
	| { kind: "inconclusive"; tried: number };

/** The distinct other hosts of the group whose visit showed nothing (invalid) or failed, a failure awaiting its retry included. */
function triedHosts(siblings: readonly Submission[], submission: WebsiteCase): number {
	const own = hostOf(submission.data.website.url);
	const hosts = new Set<string>();
	for (const sibling of siblings) {
		if (sibling.id === submission.id || isExtraVisit(sibling) || !isWebsiteCase(sibling) || sibling.data.website.collected) continue;
		if (sibling.status !== "invalid" && sibling.status !== "failed") continue;
		const host = hostOf(sibling.data.website.url);
		if (host && host !== own) hosts.add(host);
	}
	return hosts.size;
}

/**
 * Whether a host of a registrable domain is visited. Once a host of its
 * domain is reported (or taken down), it is collected into that report
 * instead; once `SIBLING_TRIAL_LIMIT` other hosts were visited without a
 * finding, it is left unvisited. A platform tenant, an address, a re-report
 * and a redirector's daily visit always visit.
 */
export async function decideSiblingVisit(submission: WebsiteCase): Promise<SiblingDecision> {
	if (!submission.siteGroup || isExtraVisit(submission) || !groupDomain(submission)) return { kind: "visit" };
	const report = await siteGroupReport(submission.siteGroup);
	if (report && report.submissionId !== submission.id) return { kind: "collect", report };
	const tried = triedHosts(await SubmissionsEntity.listSiteGroupCases(submission.siteGroup), submission);
	return tried >= SIBLING_TRIAL_LIMIT ? { kind: "inconclusive", tried } : { kind: "visit" };
}

/** The job that checks, with one plain fetch, that a collected host serves what its report's host served. */
export const probeJobKey = (submissionId: bigint, reportId: bigint) => `probe-collected:${submissionId.toString()}:${reportId.toString()}`;

/**
 * Collect a host into its site group's report: the report names the case
 * (`abuse_report_cases`), so it is a member of the report's campaign and the
 * registrar hears of the host; its waiting visit is dropped, and one plain
 * fetch checks it serves the same content.
 */
export async function collectIntoReport(submission: WebsiteCase, report: { reportId: bigint; submissionId: bigint }): Promise<void> {
	const { website } = submission.data;
	const group = submission.siteGroup!;
	await collectCaseIntoReport(report.reportId, submission.id, website.url);
	const collected: WebsiteCollection = { reason: "sibling_reported", siteGroup: group, reportId: report.reportId.toString(), intoSubmissionId: report.submissionId.toString(), at: new Date().toISOString() };
	await SubmissionsEntity.update(submission.id, {
		status: "collected",
		info: `Not visited: ${group} is already reported; this host was added to that report.`,
		data: { kind: "website", website: { ...website, autoRetry: undefined, collected } },
	});
	await discardQueuedJob(visitJobKey(submission.id));
	await queueCaseSiteLinks(submission.id);
	await enqueueJobOnce({ jobType: "probe_collected_host", reportId: report.reportId, payload: { submissionId: submission.id.toString() }, dedupeKey: probeJobKey(submission.id, report.reportId) });
}

/** Leave a host unvisited because enough other hosts of its group showed nothing; a report of the group later collects it. */
export async function markSiblingsInconclusive(submission: WebsiteCase, tried: number): Promise<void> {
	const { website } = submission.data;
	const group = submission.siteGroup!;
	await SubmissionsEntity.update(submission.id, {
		status: "invalid",
		info: `Not visited: ${tried} other hosts of ${group} were visited and none showed a threat. Analyze it again to visit this host too.`,
		data: { kind: "website", website: { ...website, autoRetry: undefined, collected: { reason: "siblings_inconclusive", siteGroup: group, tried, at: new Date().toISOString() } } },
	});
	await discardQueuedJob(visitJobKey(submission.id));
}

/** Carry out a decision that is not a visit; false when the case is to be visited. */
export async function applySiblingDecision(submission: WebsiteCase, decision: SiblingDecision): Promise<boolean> {
	if (decision.kind === "collect") await collectIntoReport(submission, decision.report);
	else if (decision.kind === "inconclusive") await markSiblingsInconclusive(submission, decision.tried);
	return decision.kind !== "visit";
}

/**
 * Collect every host of a site group that waits for nothing a visit could
 * still tell: queued ones not yet being visited, failed ones awaiting their
 * automatic retry, and those left unvisited as inconclusive. With
 * `includeSettled`, failed and invalid ones too (a clean-up of a group that
 * was visited host by host). A host being visited finishes its visit, and a
 * host with a report of its own keeps it. Returns how many it collected.
 */
export async function collectSiteGroup(group: string, options: { includeSettled?: boolean } = {}): Promise<number> {
	const report = await siteGroupReport(group);
	if (!report) return 0;
	let collected = 0;
	for (const sibling of await SubmissionsEntity.listSiteGroupCases(group)) {
		if (!isWebsiteCase(sibling) || sibling.id === report.submissionId || isExtraVisit(sibling) || !groupDomain(sibling)) continue;
		const { website } = sibling.data;
		const waiting = (sibling.status === "queued" && (await latestJobByDedupeKey(visitJobKey(sibling.id)))?.status !== "running")
			|| (sibling.status === "failed" && Boolean(website.autoRetry))
			|| (sibling.status === "invalid" && website.collected?.reason === "siblings_inconclusive");
		const settled = options.includeSettled === true && (sibling.status === "failed" || sibling.status === "invalid");
		if (!waiting && !settled) continue;
		if (await getReportForSubmission(sibling.id)) continue;
		await collectIntoReport(sibling, report);
		collected++;
	}
	return collected;
}

/** After a case is reported: its site group's waiting hosts join the report instead of being visited. */
export async function collectSiblingsOf(submissionId: bigint): Promise<number> {
	const submission = await SubmissionsEntity.get(submissionId);
	return isWebsiteCase(submission) && submission.siteGroup && groupDomain(submission) ? collectSiteGroup(submission.siteGroup) : 0;
}

/**
 * Undo a collection before the host is visited on its own: the report no
 * longer names it and its campaign membership through the report ends.
 * Returns the case's data without the collection.
 */
export async function releaseCollection(submission: WebsiteCase): Promise<WebsiteSubmissionData> {
	const { collected, ...website } = submission.data.website;
	if (collected?.reason === "sibling_reported") {
		const reportId = BigInt(collected.reportId);
		await releaseCollectedCase(reportId, submission.id);
		await CampaignRepository.removeMember({ submissionId: submission.id, reportId });
	}
	return website;
}

export type CollectedHostProbeDependencies = { verify?: typeof verifyReportedContent };

/**
 * One plain fetch of a collected host, compared with what its report's host
 * served (`verifyReportedContent` at its fetch tier, recorded nowhere on the
 * report). Same content or gone: it stays collected. Different, while the
 * report's own host still answers the same fetch with its content (so a plain
 * fetch can tell): a wildcard host serving something else, visited on its own.
 * When the report's host answers plain fetches with nothing either, nothing
 * can be told without a browser and the host stays collected.
 */
export async function probeCollectedHost(submissionId: bigint, dependencies: CollectedHostProbeDependencies = {}, signal?: AbortSignal): Promise<WebsiteCollection | undefined> {
	const submission = await SubmissionsEntity.get(submissionId);
	if (!isWebsiteCase(submission) || submission.status !== "collected") return undefined;
	const { collected } = submission.data.website;
	if (collected?.reason !== "sibling_reported") return undefined;
	const reportId = BigInt(collected.reportId);
	const [target] = await listTargets(reportId);
	if (!target) return undefined;
	const options = { maxTier: "fetch" as const, record: false, ...(signal ? { signal } : {}) };
	const verify = dependencies.verify ?? verifyReportedContent;
	const probe = await verify({ reportId, targetId: target.id, url: submission.data.website.url }, options);
	let verdict: "same" | "gone" | "unknown" = probe.verdict === "served" ? "same" : probe.verdict === "gone" ? "gone" : "unknown";
	if (verdict === "unknown") {
		const reference = await verify({ reportId, targetId: target.id, url: target.observedUrls[0] ?? `https://${target.normalizedTarget}/` }, options);
		if (reference.verdict === "served") {
			const website = await releaseCollection(submission);
			await SubmissionsEntity.update(submission.id, {
				status: "queued",
				info: `This host served other content than ${target.normalizedTarget}, the reported host of ${collected.siteGroup}; it is visited on its own.`,
				data: { kind: "website", website },
			});
			await enqueueWebsiteVisit({ submission, trigger: "initial", revisit: true });
			return undefined;
		}
	}
	const probed: WebsiteCollection = { ...collected, probe: { verdict, at: new Date().toISOString() } };
	await SubmissionsEntity.update(submission.id, { data: { kind: "website", website: { ...submission.data.website, collected: probed } } });
	return probed;
}
