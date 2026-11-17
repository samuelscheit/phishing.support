import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { getDb } from "../db";
import { generateId } from "../db/ids";
import { submissions, type Submission } from "../db/schema";
import { assignCampaigns } from "./cluster";
import type { ExtractedIndicator } from "./indicators";
import { campaignIndicators, campaignMembers, campaigns, campaignSiteFacts, kitHashChecks, type Campaign, type CampaignIndicator } from "./schema";

export type CampaignMemberView = {
	submissionId: bigint;
	joinedAt: Date;
	url: string;
	status: Submission["status"];
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

function websiteUrl(submission: Pick<Submission, "data">): string {
	return submission.data.kind === "website" ? submission.data.website.url : "";
}

/**
 * Recompute every campaign from the linking indicators on record. Members
 * keep the oldest campaign id of their group; merged and emptied campaigns
 * are marked, never deleted, because referrals were filed under them.
 */
function recluster(tx: any): void {
	const links = tx
		.select({ submissionId: campaignIndicators.submissionId, kind: campaignIndicators.kind, value: campaignIndicators.value })
		.from(campaignIndicators)
		.where(eq(campaignIndicators.links, true))
		.all() as Array<{ submissionId: bigint; kind: string; value: string }>;
	const existingRows = tx.select().from(campaignMembers).all() as Array<{ submissionId: bigint; campaignId: bigint; joinedAt: Date }>;
	const existing = new Map(existingRows.map((row) => [row.submissionId, row.campaignId]));
	// Every reported website is a confirmed site, and every site with indicators on record was one.
	const sites = [
		...(tx.select({ id: submissions.id }).from(submissions).where(and(eq(submissions.kind, "website"), eq(submissions.status, "reported"))).all() as Array<{ id: bigint }>).map((row) => row.id),
		...(tx.selectDistinct({ id: campaignIndicators.submissionId }).from(campaignIndicators).all() as Array<{ id: bigint }>).map((row) => row.id),
	];
	const assignment = assignCampaigns({
		links: links.map((link) => ({ submissionId: link.submissionId, key: `${link.kind}:${link.value}` })),
		sites: [...new Set(sites)],
		existing,
		newId: generateId,
	});
	const timestamp = new Date();
	for (const campaignId of assignment.created) {
		tx.insert(campaigns).values({ id: campaignId, createdAt: timestamp, updatedAt: timestamp }).run();
	}
	const touched = new Set<bigint>();
	for (const [submissionId, campaignId] of assignment.membership) {
		const previous = existing.get(submissionId);
		if (previous === campaignId) continue;
		touched.add(campaignId);
		if (previous !== undefined) touched.add(previous);
		if (previous === undefined) {
			tx.insert(campaignMembers).values({ submissionId, campaignId, joinedAt: timestamp }).run();
		} else {
			tx.update(campaignMembers).set({ campaignId, joinedAt: timestamp }).where(eq(campaignMembers.submissionId, submissionId)).run();
		}
	}
	for (const [submissionId, previous] of existing) {
		if (assignment.membership.has(submissionId)) continue;
		tx.delete(campaignMembers).where(eq(campaignMembers.submissionId, submissionId)).run();
		touched.add(previous);
	}
	for (const [absorbed, into] of assignment.merged) {
		tx.update(campaigns).set({ mergedInto: into, updatedAt: timestamp }).where(eq(campaigns.id, absorbed)).run();
	}
	for (const campaignId of touched) {
		tx.update(campaigns).set({ updatedAt: timestamp }).where(eq(campaigns.id, campaignId)).run();
	}
}

export const CampaignRepository = {
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

	/**
	 * Replace what is on record for one submission with what it shows now and
	 * regroup campaigns in the same transaction, so a reader never sees the
	 * new indicators under the old grouping. Returns the submission's campaign.
	 */
	async recordIndicators(submissionId: bigint, indicators: readonly ExtractedIndicator[]): Promise<bigint | undefined> {
		const db = await getDb();
		return db.transaction((tx) => {
			tx.delete(campaignIndicators).where(eq(campaignIndicators.submissionId, submissionId)).run();
			const timestamp = new Date();
			for (const indicator of indicators) {
				tx.insert(campaignIndicators).values({ id: generateId(), submissionId, ...indicator, createdAt: timestamp }).run();
			}
			recluster(tx);
			return tx.select().from(campaignMembers).where(eq(campaignMembers.submissionId, submissionId)).get()?.campaignId;
		}, { behavior: "immediate" });
	},

	/** Regroup every campaign from the indicators on record. */
	async recluster(): Promise<void> {
		const db = await getDb();
		db.transaction((tx) => recluster(tx), { behavior: "immediate" });
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

	async campaignForSubmission(submissionId: bigint): Promise<bigint | undefined> {
		const db = await getDb();
		return db.select().from(campaignMembers).where(eq(campaignMembers.submissionId, submissionId)).get()?.campaignId;
	},

	/** Every confirmed site of a campaign with what it showed, oldest first. */
	async listMembers(campaignId: bigint): Promise<CampaignMemberView[]> {
		const db = await getDb();
		const rows = db
			.select({ member: campaignMembers, submission: submissions })
			.from(campaignMembers)
			.innerJoin(submissions, eq(submissions.id, campaignMembers.submissionId))
			.where(eq(campaignMembers.campaignId, campaignId))
			.orderBy(asc(submissions.createdAt), asc(submissions.id))
			.all();
		if (!rows.length) return [];
		const indicators = db
			.select()
			.from(campaignIndicators)
			.where(inArray(campaignIndicators.submissionId, rows.map((row) => row.member.submissionId)))
			.orderBy(asc(campaignIndicators.kind), asc(campaignIndicators.value))
			.all();
		return rows.map(({ member, submission }) => ({
			submissionId: member.submissionId,
			joinedAt: member.joinedAt,
			url: websiteUrl(submission),
			status: submission.status,
			createdAt: submission.createdAt,
			indicators: indicators.filter((indicator) => indicator.submissionId === member.submissionId),
		}));
	},

	/** Current campaigns, most recently grown first. */
	async listCampaigns(limit = 200): Promise<CampaignSummary[]> {
		const db = await getDb();
		const rows = db
			.select({
				campaign: campaigns,
				memberCount: sql<number>`count(${campaignMembers.submissionId})`,
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
			const members = db
				.select({ data: submissions.data, indicator: campaignIndicators })
				.from(campaignMembers)
				.innerJoin(submissions, eq(submissions.id, campaignMembers.submissionId))
				.leftJoin(campaignIndicators, and(eq(campaignIndicators.submissionId, campaignMembers.submissionId), eq(campaignIndicators.links, true)))
				.where(eq(campaignMembers.campaignId, row.campaign.id))
				.all();
			const distinct = new Map<string, Set<string>>();
			for (const { indicator } of members) {
				if (!indicator) continue;
				distinct.set(indicator.kind, (distinct.get(indicator.kind) ?? new Set()).add(indicator.value));
			}
			summaries.push({
				campaign: row.campaign,
				memberCount: Number(row.memberCount),
				firstSeenAt: new Date(Number(row.firstSeenAt)),
				lastSeenAt: new Date(Number(row.lastSeenAt)),
				linkingIndicators: Object.fromEntries([...distinct].map(([kind, values]) => [kind, values.size])),
				sampleUrls: [...new Set(members.map(({ data }) => websiteUrl({ data })))].slice(0, 3),
			});
		}
		return summaries;
	},

	async saveSiteFacts(submissionId: bigint, facts: { language: string | null; thumbnailArtifactId: bigint | null }) {
		const db = await getDb();
		const values = { submissionId, ...facts, updatedAt: new Date() };
		await db.insert(campaignSiteFacts).values(values).onConflictDoUpdate({ target: campaignSiteFacts.submissionId, set: values });
	},

	async listSiteFacts(submissionIds: readonly bigint[]) {
		if (!submissionIds.length) return [];
		const db = await getDb();
		return db.select().from(campaignSiteFacts).where(inArray(campaignSiteFacts.submissionId, [...submissionIds])).all();
	},

	async memberCount(campaignId: bigint): Promise<number> {
		const db = await getDb();
		const row = db.select({ count: sql<number>`count(*)` }).from(campaignMembers).where(eq(campaignMembers.campaignId, campaignId)).get();
		return Number(row?.count ?? 0);
	},

	async saveDescription(campaignId: bigint, description: { title: string; summary: string; siteCount: number }) {
		const db = await getDb();
		await db.update(campaigns)
			.set({ title: description.title, summary: description.summary, summarySiteCount: description.siteCount, summaryGeneratedAt: new Date() })
			.where(eq(campaigns.id, campaignId));
	},

	/** Current campaigns whose title and summary describe another number of sites than they now have. */
	async listCampaignsNeedingDescription(): Promise<bigint[]> {
		const db = await getDb();
		return db
			.select({ id: campaigns.id })
			.from(campaigns)
			.where(and(isNull(campaigns.mergedInto), sql`coalesce(${campaigns.summarySiteCount}, -1) <> (select count(*) from campaign_members where campaign_members.campaign_id = ${campaigns.id})`, sql`exists (select 1 from campaign_members where campaign_members.campaign_id = ${campaigns.id})`))
			.all()
			.map((row) => row.id);
	},

	/** Website submissions confirmed as phishing, oldest first, for a full rebuild. */
	async listReportedWebsiteSubmissionIds(): Promise<bigint[]> {
		const db = await getDb();
		return db
			.select({ id: submissions.id })
			.from(submissions)
			.where(and(eq(submissions.kind, "website"), eq(submissions.status, "reported")))
			.orderBy(asc(submissions.createdAt))
			.all()
			.map((row) => row.id);
	},
};
