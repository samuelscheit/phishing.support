import { z } from "zod";

import { SubmissionsEntity } from "../db/entities";
import { AbuseRepository } from "../abuse/repository";
import type { AbuseJob } from "../abuse/schema";
import { throwIfAborted } from "../abuse/worker/shared";
import { isKitSiblingSeed } from "../abuse/origin/kit_job";
import { isUrlscanBusy, urlscanRetryAfterMs } from "../abuse/origin/urlscan";
import { errorSummary } from "../error_text";
import { searchKitHashes, type KitFingerprint, type KitFingerprintKind, type SiblingDiscoveryDependencies } from "../abuse/origin/siblings";
import { websiteSubmissionDedupeKey } from "../submissions/website";
import { CampaignRepository, type CampaignMemberView } from "./repository";
import { DAY_MS } from "../duration";

/**
 * The kit search of one campaign: its sites' own kit files are looked up on
 * urlscan.io again and again, so a copy of the kit that goes up next week
 * under a new domain is found and analyzed like any submission. Daily while
 * the campaign keeps growing, weekly once it is quiet, and not at all after
 * it stayed quiet for two months; a site that joins it starts it again.
 */

/** A campaign that found a new site within this long is searched daily, otherwise weekly. */
const ACTIVE_FOR_MS = 14 * DAY_MS;
/** A campaign that found nothing new for this long is no longer searched. */
const QUIET_END_MS = 60 * DAY_MS;
/** Files searched per run, largest first: urlscan allows 1,000 searches a day for every campaign together. */
const MAX_HASHES_PER_SEARCH = 5;
/** Analyses of new candidates start this far apart, so captures do not all start at once. */
const ANALYSIS_SPACING_MS = 30_000;
const SEARCHABLE_KINDS = new Set<KitFingerprintKind>(["script", "hidden_frame"]);

const stateSchema = z.object({
	campaignId: z.string().regex(/^\d{1,20}$/),
	checks: z.number().int().nonnegative(),
	lastNewAt: z.string().datetime(),
});
export type CampaignKitSearchState = z.infer<typeof stateSchema>;

const searchDedupeKey = (campaignId: bigint) => `campaign-kit-search:${campaignId.toString()}`;
const analysisDedupeKey = (site: string) => `analyze-kit-sibling:${site}`;

/** Every host a campaign's sites were reached on: the submitted address, where it led, and the captured page's. */
async function memberHosts(members: readonly CampaignMemberView[]): Promise<string[]> {
	const hosts = new Set<string>();
	for (const member of members) {
		hosts.add(new URL(member.url).hostname);
		const submission = await SubmissionsEntity.get(member.submissionId);
		if (submission?.data.kind !== "website") continue;
		const { archiveUrl, navigationHops } = submission.data.website;
		if (archiveUrl) hosts.add(new URL(archiveUrl).hostname);
		for (const hop of navigationHops ?? []) hosts.add(hop.hostname);
	}
	return [...hosts];
}

/**
 * The files a campaign is searched by: its sites' own code that links them.
 * A file only a site found by an earlier search holds is not searched (that
 * let one search drift from kit to kit across unrelated sites); a file two
 * confirmed sites share, or an original report's site holds, is.
 */
export async function searchableKitFingerprints(members: readonly CampaignMemberView[]): Promise<KitFingerprint[]> {
	const holders = new Map<string, { fingerprint: KitFingerprint; sites: Set<bigint> }>();
	for (const member of members) {
		for (const indicator of member.indicators) {
			const evidence = indicator.evidence as { fileKind?: string; url?: string; size?: number };
			if (indicator.kind !== "kit_fingerprint" || !indicator.links || !SEARCHABLE_KINDS.has(evidence.fileKind as KitFingerprintKind) || !evidence.url) continue;
			const entry = holders.get(indicator.value) ?? { fingerprint: { sha256: indicator.value, kind: evidence.fileKind as KitFingerprintKind, url: evidence.url, size: evidence.size ?? 0 }, sites: new Set<bigint>() };
			entry.sites.add(member.submissionId);
			holders.set(indicator.value, entry);
		}
	}
	const seeds = new Map<bigint, boolean>();
	const searchable: KitFingerprint[] = [];
	for (const { fingerprint, sites } of holders.values()) {
		let original = false;
		for (const site of sites) {
			if (!seeds.has(site)) seeds.set(site, await isKitSiblingSeed(site));
			original ||= seeds.get(site)!;
		}
		if (original || sites.size >= 2) searchable.push(fingerprint);
	}
	return searchable.sort((a, b) => b.size - a.size || a.sha256.localeCompare(b.sha256)).slice(0, MAX_HASHES_PER_SEARCH);
}

/** The report a campaign's search belongs to: its first original site's, else its first site's that has one. */
async function campaignReport(members: readonly CampaignMemberView[]): Promise<{ reportId: bigint; submissionId: bigint } | undefined> {
	let fallback: { reportId: bigint; submissionId: bigint } | undefined;
	for (const member of members) {
		const report = await AbuseRepository.getReportForSubmission(member.submissionId);
		if (!report) continue;
		const found = { reportId: report.id, submissionId: member.submissionId };
		if (await isKitSiblingSeed(member.submissionId)) return found;
		fallback ??= found;
	}
	return fallback;
}

/**
 * Start the campaign's search unless it is already running; true when it
 * runs. It counts as quiet since its newest site joined: a sweep starting
 * the search of a campaign that stopped growing long ago runs it once.
 */
export async function armCampaignKitSearch(campaignId: bigint, now = new Date()): Promise<boolean> {
	const members = await CampaignRepository.listMembers(campaignId);
	if (!(await searchableKitFingerprints(members)).length) return false;
	const report = await campaignReport(members);
	if (!report) return false;
	const newest = Math.max(...members.map(({ createdAt }) => createdAt.getTime()));
	const state: CampaignKitSearchState = { campaignId: campaignId.toString(), checks: 0, lastNewAt: new Date(Math.min(newest, now.getTime())).toISOString() };
	await AbuseRepository.enqueueJob({ jobType: "search_campaign_kits", reportId: report.reportId, payload: state, dedupeKey: searchDedupeKey(campaignId), nextAttemptAt: now });
	return true;
}

export type CampaignKitSearchDependencies = SiblingDiscoveryDependencies & {
	now?: () => Date;
};

/**
 * One search of a campaign's kit files. Each domain urlscan shows them on
 * that has no case yet is analyzed in its own job, as the campaign's first
 * report's sibling; the analysis alone decides whether it is reported and
 * joins the campaign.
 */
export async function searchCampaignKits(params: { job: AbuseJob; signal?: AbortSignal }, dependencies: CampaignKitSearchDependencies = {}): Promise<void> {
	const { job, signal } = params;
	const parsed = stateSchema.safeParse(job.payload);
	if (!parsed.success || !job.reportId) throw new Error("Campaign kit search job has an invalid state.");
	const state = parsed.data;
	const now = (dependencies.now ?? (() => new Date()))();
	const campaignId = BigInt(state.campaignId);
	const event = (data: Record<string, unknown>) => AbuseRepository.appendEvent({ reportId: job.reportId!, jobId: job.id, eventType: "kit_siblings.discovered", data: { campaignId: state.campaignId, ...data } });

	// A campaign merged into another is searched as that one.
	const current = await CampaignRepository.currentCampaignId(campaignId);
	if (current !== campaignId) {
		await event({ ended: current ? `merged into campaign ${current.toString()}` : "the campaign no longer exists" });
		if (current) await armCampaignKitSearch(current, now);
		return;
	}
	const members = await CampaignRepository.listMembers(campaignId);
	const fingerprints = await searchableKitFingerprints(members);
	if (!fingerprints.length) {
		await event({ ended: "no site of the campaign has kit code to search for" });
		return;
	}
	let found: Awaited<ReturnType<typeof searchKitHashes>>;
	try {
		found = await searchKitHashes({ fingerprints, knownDomains: await memberHosts(members), signal }, dependencies);
	} catch (error) {
		if (!isUrlscanBusy(error)) throw error;
		// urlscan's quota or load: the same search runs once it may answer, nothing concluded.
		const retryAt = new Date(now.getTime() + urlscanRetryAfterMs(error));
		await event({ deferred: errorSummary(error), retryAt: retryAt.toISOString() });
		await AbuseRepository.enqueueJob({ jobType: "search_campaign_kits", reportId: job.reportId, payload: state, dedupeKey: searchDedupeKey(campaignId), nextAttemptAt: retryAt, successorOf: job.id });
		return;
	}
	throwIfAborted(signal);

	// A site with a case already, or whose analysis is already queued, is never opened twice.
	const fresh: typeof found.candidates = [];
	for (const candidate of found.candidates) {
		const site = websiteSubmissionDedupeKey(candidate.url);
		if (await SubmissionsEntity.findIdByDedupeKey(site) !== undefined || await AbuseRepository.hasJob(analysisDedupeKey(site))) continue;
		fresh.push(candidate);
	}
	for (const [index, candidate] of fresh.entries()) {
		throwIfAborted(signal);
		await AbuseRepository.enqueueJobOnce({
			jobType: "analyze_kit_sibling",
			reportId: job.reportId,
			payload: { url: candidate.url },
			dedupeKey: analysisDedupeKey(websiteSubmissionDedupeKey(candidate.url)),
			nextAttemptAt: new Date(now.getTime() + index * ANALYSIS_SPACING_MS),
		});
	}

	const checks = state.checks + 1;
	const lastNewAt = fresh.length ? now.toISOString() : state.lastNewAt;
	const quietFor = now.getTime() - Date.parse(lastNewAt);
	const ended = quietFor >= QUIET_END_MS ? `nothing new in ${Math.round(QUIET_END_MS / DAY_MS)} days` : undefined;
	await event({
		fingerprints: fingerprints.map(({ sha256, url, size }) => ({ sha256, url, size })),
		candidates: fresh.map(({ domain }) => domain),
		errors: found.errors,
		checks,
		...(ended ? { ended } : {}),
	});
	if (ended) return;
	const next: CampaignKitSearchState = { campaignId: state.campaignId, checks, lastNewAt };
	await AbuseRepository.enqueueJob({
		jobType: "search_campaign_kits",
		reportId: job.reportId,
		payload: next,
		dedupeKey: searchDedupeKey(campaignId),
		nextAttemptAt: new Date(now.getTime() + (quietFor < ACTIVE_FOR_MS ? DAY_MS : 7 * DAY_MS)),
		successorOf: job.id,
	});
}
