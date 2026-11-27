import type { CapturePage } from "../website/visit/capture_files";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { getDb, type DbExecutor, type Transaction } from "../db";
import { generateId } from "../db/ids";
import { abuseReportCases, abuseReports, abuseTargets, submissions, type Submission } from "../db/schema";
import { assignCampaigns } from "./cluster";
import type { VisitorGuidance } from "./guidance";
import type { ExtractedIndicator } from "./indicators";
import { judgedSitePage, memberKey, reportSite, type CampaignMember, type CampaignSite } from "./members";
import { campaignIndicators, campaignMembers, campaigns, campaignSiteFacts, kitHashChecks, kitHostChecks, type Campaign, type CampaignIndicator } from "./schema";

export type CampaignMemberView = CampaignSite & {
	joinedAt: Date;
	/** The case's judged page of the site, else the site's first reported URL. */
	url: string;
	/** The captured judged page (route and step), when the case captured one of the site. */
	page?: CapturePage;
	status: Submission["status"];
	/** When the case was opened: when the site was first seen by it. */
	createdAt: Date;
	indicators: CampaignIndicator[];
};

export type CampaignSummary = {
	campaign: Campaign;
	memberCount: number;
	firstSeenAt: Date;
	lastSeenAt: Date;
	/** Linking indicators by kind, counted once per distinct value. */
	linkingIndicators: Record<string, number>;
	sampleUrls: string[];
};

const isMember = (member: CampaignMember) => and(eq(campaignMembers.submissionId, member.submissionId), eq(campaignMembers.reportId, member.reportId));

/**
 * The site reports of website cases, by case age, then report: each primary
 * report (no idempotency key) a case filed itself, and each it joined
 * because another case reported the site first. Derived reports (a data
 * drop, a payload host) and a funnel's keyed reports are no site of the case.
 */
function siteReports(executor: DbExecutor, filter: { submissionId?: bigint; reportedOnly?: boolean }): CampaignMember[] {
	const caseFilter = and(
		eq(submissions.kind, "website"),
		// A collected host stands in its site group's report like a case that joined it.
		filter.reportedOnly ? inArray(submissions.status, ["reported", "collected"]) : undefined,
		filter.submissionId === undefined ? undefined : eq(submissions.id, filter.submissionId),
	);
	const owned = executor
		.select({ submissionId: submissions.id, reportId: abuseReports.id, openedAt: submissions.createdAt })
		.from(abuseReports)
		.innerJoin(submissions, eq(submissions.id, abuseReports.submissionId))
		.where(and(isNull(abuseReports.idempotencyKey), caseFilter))
		.all();
	const joined = executor
		.select({ submissionId: submissions.id, reportId: abuseReports.id, openedAt: submissions.createdAt })
		.from(abuseReportCases)
		.innerJoin(abuseReports, eq(abuseReports.id, abuseReportCases.reportId))
		.innerJoin(submissions, eq(submissions.id, abuseReportCases.submissionId))
		.where(and(isNull(abuseReports.idempotencyKey), caseFilter))
		.all();
	return [...owned, ...joined]
		.sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime() || Number(a.submissionId - b.submissionId) || Number(a.reportId - b.reportId))
		.map(({ submissionId, reportId }) => ({ submissionId, reportId }));
}

/** The site each report is about, with the first URL it reported. */
function reportSites(executor: DbExecutor, reportIds: readonly bigint[]): Map<bigint, { site: string; url: string }> {
	const sites = new Map<bigint, { site: string; url: string }>();
	if (!reportIds.length) return sites;
	const targets = executor
		.select({ reportId: abuseTargets.reportId, normalizedTarget: abuseTargets.normalizedTarget, observedUrls: abuseTargets.observedUrls })
		.from(abuseTargets)
		.where(inArray(abuseTargets.reportId, [...new Set(reportIds)]))
		.orderBy(asc(abuseTargets.ordinal))
		.all();
	for (const target of targets) {
		if (!sites.has(target.reportId)) sites.set(target.reportId, { site: reportSite(target), url: target.observedUrls[0] ?? `https://${target.normalizedTarget}/` });
	}
	return sites;
}

/**
 * Recompute every campaign from the linking indicators on record. Members
 * keep the oldest campaign id of their group; merged and emptied campaigns
 * are marked, never deleted, because referrals were filed under them.
 */
function recluster(tx: Transaction): void {
	const links = tx
		.select({ submissionId: campaignIndicators.submissionId, reportId: campaignIndicators.reportId, kind: campaignIndicators.kind, value: campaignIndicators.value })
		.from(campaignIndicators)
		.where(eq(campaignIndicators.links, true))
		.all();
	const existingRows = tx.select().from(campaignMembers).all();
	const existing = new Map(existingRows.map((row) => [memberKey(row), row.campaignId]));
	// Every site a reported website case confirmed is a member, and every member with indicators on record was one.
	const sites = [
		...siteReports(tx, { reportedOnly: true }),
		...tx.selectDistinct({ submissionId: campaignIndicators.submissionId, reportId: campaignIndicators.reportId }).from(campaignIndicators).all(),
	];
	const members = new Map<string, CampaignMember>();
	for (const member of [...existingRows, ...sites]) members.set(memberKey(member), { submissionId: member.submissionId, reportId: member.reportId });
	const assignment = assignCampaigns({
		links: links.map((link) => ({ member: memberKey(link), key: `${link.kind}:${link.value}` })),
		sites: [...new Set(sites.map(memberKey))],
		existing,
		newId: generateId,
	});
	const timestamp = new Date();
	for (const campaignId of assignment.created) {
		tx.insert(campaigns).values({ id: campaignId, createdAt: timestamp, updatedAt: timestamp }).run();
	}
	const touched = new Set<bigint>();
	for (const [key, campaignId] of assignment.membership) {
		const previous = existing.get(key);
		if (previous === campaignId) continue;
		const member = members.get(key)!;
		touched.add(campaignId);
		if (previous !== undefined) touched.add(previous);
		if (previous === undefined) {
			tx.insert(campaignMembers).values({ ...member, campaignId, joinedAt: timestamp }).run();
		} else {
			tx.update(campaignMembers).set({ campaignId, joinedAt: timestamp }).where(isMember(member)).run();
		}
	}
	for (const [key, previous] of existing) {
		if (assignment.membership.has(key)) continue;
		tx.delete(campaignMembers).where(isMember(members.get(key)!)).run();
		touched.add(previous);
	}
	for (const [absorbed, into] of assignment.merged) {
		tx.update(campaigns).set({ mergedInto: into, updatedAt: timestamp }).where(eq(campaigns.id, absorbed)).run();
	}
	for (const campaignId of touched) {
		tx.update(campaigns).set({ updatedAt: timestamp }).where(eq(campaigns.id, campaignId)).run();
	}
}

/** Sites outside a report's own campaign that may share a kit file before it counts as everyone's, not the kit's. */
const MAX_UNRELATED_KIT_FILE_SITES = 2;

export const CampaignRepository = {
	/**
	 * Whether a file of a reported site is one many sites serve, so serving
	 * it proves nothing about which site it is: a published library file
	 * (jsDelivr), a file the campaign indicators already set aside as a
	 * library or platform file, or one recorded for sites on more registrable
	 * domains outside the report's campaign than one operator's kit reaches.
	 */
	async isSharedKitFile(sha256: string, reportId: bigint): Promise<boolean> {
		const db = await getDb();
		if (db.select().from(kitHashChecks).where(eq(kitHashChecks.sha256, sha256)).get()?.library) return true;
		const recorded = db.select({ reportId: campaignIndicators.reportId, links: campaignIndicators.links })
			.from(campaignIndicators)
			.where(and(eq(campaignIndicators.kind, "kit_fingerprint"), eq(campaignIndicators.value, sha256)))
			.all();
		if (recorded.some(({ links }) => !links)) return true;
		const own = new Set(db.select({ campaignId: campaignMembers.campaignId }).from(campaignMembers).where(eq(campaignMembers.reportId, reportId)).all().map(({ campaignId }) => campaignId));
		const others = [...new Set(recorded.map((entry) => entry.reportId))].filter((other) => other !== reportId);
		if (!others.length) return false;
		const related = new Set(own.size
			? db.select({ reportId: campaignMembers.reportId }).from(campaignMembers)
				.where(and(inArray(campaignMembers.reportId, others), inArray(campaignMembers.campaignId, [...own])))
				.all().map((entry) => entry.reportId)
			: []);
		const unrelated = others.filter((other) => !related.has(other));
		if (!unrelated.length) return false;
		const sites = new Set(db.select({ normalizedTarget: abuseTargets.normalizedTarget, observedUrls: abuseTargets.observedUrls }).from(abuseTargets)
			.where(and(inArray(abuseTargets.reportId, unrelated), eq(abuseTargets.ordinal, 0)))
			.all().map(reportSite));
		return sites.size > MAX_UNRELATED_KIT_FILE_SITES;
	},

	async getKitHashCheck(sha256: string) {
		const db = await getDb();
		return db.select().from(kitHashChecks).where(eq(kitHashChecks.sha256, sha256)).get();
	},

	async saveKitHashCheck(sha256: string, library: string | undefined) {
		const db = await getDb();
		await db.insert(kitHashChecks)
			.values({ sha256, library: library ?? null, checkedAt: new Date() })
			.onConflictDoUpdate({ target: kitHashChecks.sha256, set: { library: library ?? null, checkedAt: new Date() } });
	},

	async getKitHostCheck(host: string) {
		const db = await getDb();
		return db.select().from(kitHostChecks).where(eq(kitHostChecks.host, host)).get();
	},

	async saveKitHostCheck(host: string, platform: boolean) {
		const db = await getDb();
		await db.insert(kitHostChecks)
			.values({ host, platform, checkedAt: new Date() })
			.onConflictDoUpdate({ target: kitHostChecks.host, set: { platform, checkedAt: new Date() } });
	},

	/**
	 * Replace what is on record for one member with what it shows now and
	 * regroup campaigns in the same transaction, so a reader never sees the
	 * new indicators under the old grouping. Returns the member's campaign.
	 */
	async recordIndicators(member: CampaignMember, indicators: readonly ExtractedIndicator[]): Promise<bigint | undefined> {
		const db = await getDb();
		return db.transaction((tx) => {
			tx.delete(campaignIndicators).where(and(eq(campaignIndicators.submissionId, member.submissionId), eq(campaignIndicators.reportId, member.reportId))).run();
			const timestamp = new Date();
			for (const indicator of indicators) {
				tx.insert(campaignIndicators).values({ id: generateId(), submissionId: member.submissionId, reportId: member.reportId, ...indicator, createdAt: timestamp }).run();
			}
			recluster(tx);
			return tx.select().from(campaignMembers).where(isMember(member)).get()?.campaignId;
		}, { behavior: "immediate" });
	},

	/** The sites a website case confirmed, as members: one per site report it filed or joined. */
	async listCaseSites(submissionId: bigint): Promise<CampaignMember[]> {
		return siteReports(await getDb(), { submissionId });
	},

	/** Every site every reported website case confirmed, oldest case first, for a sweep over every member. */
	async listConfirmedSites(): Promise<CampaignMember[]> {
		return siteReports(await getDb(), { reportedOnly: true });
	},

	/** The site a member is about; undefined when its report is no site report of its case (a data drop's, a funnel's). */
	async siteOf(member: CampaignMember): Promise<string | undefined> {
		const db = await getDb();
		if (!siteReports(db, { submissionId: member.submissionId }).some((site) => site.reportId === member.reportId)) return undefined;
		return reportSites(db, [member.reportId]).get(member.reportId)?.site;
	},

	async getCampaign(campaignId: bigint): Promise<Campaign | undefined> {
		const db = await getDb();
		return db.select().from(campaigns).where(eq(campaigns.id, campaignId)).get();
	},

	/** The campaign a merged one now lives in, following every merge. */
	async currentCampaignId(campaignId: bigint): Promise<bigint | undefined> {
		let current = await this.getCampaign(campaignId);
		for (let hops = 0; current?.mergedInto && hops < 100; hops += 1) current = await this.getCampaign(current.mergedInto);
		return current?.id;
	},

	async campaignForMember(member: CampaignMember): Promise<bigint | undefined> {
		const db = await getDb();
		return db.select().from(campaignMembers).where(isMember(member)).get()?.campaignId;
	},

	/** The campaign of each site a case is a member for, its oldest report first; one campaign can appear twice. */
	async listCaseMemberships(submissionId: bigint): Promise<Array<CampaignMember & { campaignId: bigint }>> {
		const db = await getDb();
		return db
			.select({ submissionId: campaignMembers.submissionId, reportId: campaignMembers.reportId, campaignId: campaignMembers.campaignId })
			.from(campaignMembers)
			.where(eq(campaignMembers.submissionId, submissionId))
			.orderBy(asc(campaignMembers.reportId))
			.all();
	},

	/** Every member of a campaign with what it showed, oldest case first. */
	async listMembers(campaignId: bigint): Promise<CampaignMemberView[]> {
		const db = await getDb();
		const rows = db
			.select({ member: campaignMembers, submission: submissions })
			.from(campaignMembers)
			.innerJoin(submissions, eq(submissions.id, campaignMembers.submissionId))
			.where(eq(campaignMembers.campaignId, campaignId))
			.orderBy(asc(submissions.createdAt), asc(submissions.id), asc(campaignMembers.reportId))
			.all();
		if (!rows.length) return [];
		const indicators = db
			.select()
			.from(campaignIndicators)
			.where(inArray(campaignIndicators.submissionId, rows.map((row) => row.member.submissionId)))
			.orderBy(asc(campaignIndicators.kind), asc(campaignIndicators.value))
			.all();
		const sites = reportSites(db, rows.map((row) => row.member.reportId));
		return rows.map(({ member, submission }) => {
			const reported = sites.get(member.reportId) ?? { site: "", url: "" };
			const page = submission.data.kind === "website" ? judgedSitePage(submission.data.website, reported.site) : undefined;
			return {
				submissionId: member.submissionId,
				reportId: member.reportId,
				site: reported.site,
				joinedAt: member.joinedAt,
				url: page?.url ?? reported.url,
				...(page ? { page: { route: page.route, step: page.step } } : {}),
				status: submission.status,
				createdAt: submission.createdAt,
				indicators: indicators.filter((indicator) => indicator.submissionId === member.submissionId && indicator.reportId === member.reportId),
			};
		});
	},

	/** Current campaigns, most recently grown first. */
	async listCampaigns(limit = 200): Promise<CampaignSummary[]> {
		const db = await getDb();
		const rows = db
			.select({
				campaign: campaigns,
				memberCount: sql<number>`count(*)`,
				firstSeenAt: sql<number>`min(${submissions.createdAt})`,
				lastSeenAt: sql<number>`max(${submissions.createdAt})`,
			})
			.from(campaigns)
			.innerJoin(campaignMembers, eq(campaignMembers.campaignId, campaigns.id))
			.innerJoin(submissions, eq(submissions.id, campaignMembers.submissionId))
			.where(isNull(campaigns.mergedInto))
			.groupBy(campaigns.id)
			.orderBy(desc(sql`max(${submissions.createdAt})`))
			.limit(limit)
			.all();
		const summaries: CampaignSummary[] = [];
		for (const row of rows) {
			const members = await this.listMembers(row.campaign.id);
			const distinct = new Map<string, Set<string>>();
			for (const indicator of members.flatMap((member) => member.indicators)) {
				if (!indicator.links) continue;
				distinct.set(indicator.kind, (distinct.get(indicator.kind) ?? new Set()).add(indicator.value));
			}
			summaries.push({
				campaign: row.campaign,
				memberCount: Number(row.memberCount),
				firstSeenAt: new Date(Number(row.firstSeenAt)),
				lastSeenAt: new Date(Number(row.lastSeenAt)),
				linkingIndicators: Object.fromEntries([...distinct].map(([kind, values]) => [kind, values.size])),
				sampleUrls: [...new Set(members.map((member) => member.url))].slice(0, 3),
			});
		}
		return summaries;
	},

	async saveSiteFacts(member: CampaignMember, facts: { language: string | null; thumbnailArtifactId: bigint | null; blankCapture: boolean }) {
		const db = await getDb();
		const values = { submissionId: member.submissionId, reportId: member.reportId, ...facts, updatedAt: new Date() };
		await db.insert(campaignSiteFacts).values(values).onConflictDoUpdate({ target: [campaignSiteFacts.submissionId, campaignSiteFacts.reportId], set: values });
	},

	/** The stored facts of these members, in their order; a member never linked has none. */
	async listSiteFacts(members: readonly CampaignMember[]) {
		if (!members.length) return [];
		const db = await getDb();
		const rows = db.select().from(campaignSiteFacts).where(inArray(campaignSiteFacts.submissionId, members.map((member) => member.submissionId))).all();
		const byMember = new Map(rows.map((row) => [memberKey(row), row]));
		return members.flatMap((member) => byMember.get(memberKey(member)) ?? []);
	},

	/** Drop a member whose case no longer stands in the report (a collected host visited on its own after all). */
	async removeMember(member: CampaignMember): Promise<void> {
		(await getDb()).delete(campaignMembers).where(isMember(member)).run();
	},

	async memberCount(campaignId: bigint): Promise<number> {
		const db = await getDb();
		const row = db.select({ count: sql<number>`count(*)` }).from(campaignMembers).where(eq(campaignMembers.campaignId, campaignId)).get();
		return Number(row?.count ?? 0);
	},

	async saveDescription(campaignId: bigint, description: { title: string; summary: string; siteCount: number }) {
		const db = await getDb();
		await db.update(campaigns)
			.set({ title: description.title, summary: description.summary, summarySiteCount: description.siteCount })
			.where(eq(campaigns.id, campaignId));
	},

	async saveVisitorGuidance(campaignId: bigint, guidance: VisitorGuidance) {
		const db = await getDb();
		await db.update(campaigns).set({ visitorGuidance: guidance }).where(eq(campaigns.id, campaignId));
	},
};
