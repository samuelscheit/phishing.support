import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { getDb } from "../index";
import { analysisRuns, submissions, type SubmissionData, type SubmissionKind, type SubmissionStatus } from "../schema";
import { generateId } from "../ids";
import type { ReporterMetadata } from "../../http/reporter_headers";
import { caseReportedAs, type ReportedAs } from "../../submissions/finding";

/** The URL of a website case, the subject of an email; null when it has none. */
function titleOf(data: SubmissionData): string | null {
	const title = data.kind === "website" ? data.website.url : data.email?.subject;
	return title ? title : null;
}

/** What the public list names a case by: its URL or the email's subject, else its dedupe key. */
export function submissionTitle(data: SubmissionData, dedupeKey: string): string {
	return titleOf(data) ?? dedupeKey;
}

/** What a case would be reported for, by what its data found (`caseReportedAs`); stored as `reported_as`. */
export function submissionReportedAs(data: SubmissionData): ReportedAs | null {
	return caseReportedAs(data) ?? null;
}

/**
 * One tile of the public list as `listTiles` reads it: the tile's newest case
 * with what the tile counts. A tile is a campaign (`campaignId`), else a site
 * group's cases, else one case.
 */
export type SubmissionTileRow = {
	id: bigint;
	kind: SubmissionKind;
	status: SubmissionStatus;
	createdAt: Date;
	title: string | null;
	reportedAs: ReportedAs | null;
	siteGroup: string | null;
	campaignId: bigint | null;
	/** The tile's cases of the listed statuses: all, running, queued. */
	matchedCount: number;
	runningCount: number;
	queuedCount: number;
	/** The campaign's member sites and their cases, and the site group they share, when one. */
	campaignSiteCount: number | null;
	campaignHostCount: number | null;
	campaignDomain: string | null;
};

type RawTileRow = {
	id: bigint;
	kind: SubmissionKind;
	status: SubmissionStatus;
	created_at: bigint;
	title: string | null;
	reported_as: ReportedAs | null;
	site_group: string | null;
	campaign_id: bigint | null;
	matched_count: bigint;
	running_count: bigint;
	queued_count: bigint;
	site_count: bigint | null;
	host_count: bigint | null;
	group_count: bigint | null;
	only_group: string | null;
};

const nullableNumber = (value: bigint | null) => (value === null ? null : Number(value));

/**
 * A case's place in the list as one value that sorts as (creation time, id):
 * both zero-padded to their widest (13 digits of milliseconds last until 2286,
 * 19 hold any positive 64-bit id), so max() finds a tile's newest case and a
 * comparison pages past one.
 */
function newestKey(createdAt: SQL, id: SQL): SQL {
	return sql`printf('%013d%019d', ${createdAt}, ${id})`;
}

export class SubmissionsEntity {
    static async create(params: {
        kind: SubmissionKind;
        source?: string;
        data: SubmissionData;
        dedupeKey: string;
        status?: SubmissionStatus;
        info?: string;
        id?: bigint;
        siteGroup?: string | null;
    } & ReporterMetadata) {
        const db = await getDb();
        const id = params.id ?? generateId();

        const exists = await db
            .select({
                id: submissions.id,
                status: submissions.status,
                reporterIp: submissions.reporterIp,
                reporterCountry: submissions.reporterCountry,
                reporterHeaders: submissions.reporterHeaders,
            })
            .from(submissions)
            .where(eq(submissions.dedupeKey, params.dedupeKey))
            .limit(1);

        if (exists.length > 0) {
            if (exists[0].status === "failed") {
                await db.delete(submissions).where(eq(submissions.id, exists[0].id));
            } else {
                // A submission may first be created by an internal source and later
                // encountered through the HTTP endpoint. Fill only missing metadata so
                // the original reporter remains authoritative for deduplicated rows.
                const existing = exists[0];
                const metadata: Partial<typeof submissions.$inferInsert> = {};
                if (!existing.reporterIp && params.reporterIp) metadata.reporterIp = params.reporterIp;
                if (!existing.reporterCountry && params.reporterCountry) metadata.reporterCountry = params.reporterCountry;
                if (!existing.reporterHeaders && params.reporterHeaders) metadata.reporterHeaders = params.reporterHeaders;
                if (Object.keys(metadata).length > 0) {
                    await db.update(submissions).set({ ...metadata, updatedAt: new Date() }).where(eq(submissions.id, existing.id));
                }
                return exists[0].id;
            }
        }

        const [row] = await db
            .insert(submissions)
            .values([
                {
                    id,
                    kind: params.kind,
                    source: params.source,
                    data: params.data,
                    dedupeKey: params.dedupeKey,
                    // Analysis starts right after insertion; a restart fails what is still running.
                    status: params.status ?? "running",
                    info: params.info,
                    reporterIp: params.reporterIp,
                    reporterCountry: params.reporterCountry,
                    reporterHeaders: params.reporterHeaders,
                    siteGroup: params.siteGroup,
                    title: submissionTitle(params.data, params.dedupeKey),
                    reportedAs: submissionReportedAs(params.data),
                    updatedAt: new Date(),
                },
            ])
            .returning({ id: submissions.id });
        return row!.id;
    }

    /**
     * Fail the email analyses a restart cut off, with their runs. Website
     * cases are not touched: their visit jobs resume them (website/visit_queue).
     */
    static async failRunningEmails(params?: { info?: string }) {
        const db = await getDb();
        const info = params?.info ?? "Marked as failed (previous run did not complete).";
        const rows = await db
            .update(submissions)
            .set({ status: "failed", info, updatedAt: new Date() })
            .where(and(eq(submissions.kind, "email"), eq(submissions.status, "running")))
            .returning({ id: submissions.id });
        for (const { id } of rows) await SubmissionsEntity.failRunningAnalysisRuns(id, info);
        return rows;
    }

    /** Fail a case's analysis runs that are still marked running: their process is gone. */
    static async failRunningAnalysisRuns(submissionId: bigint, info: string) {
        const db = await getDb();
        await db
            .update(analysisRuns)
            .set({ status: "failed", data: { lastError: info, failedAt: new Date().toISOString() } })
            .where(and(eq(analysisRuns.submissionId, submissionId), eq(analysisRuns.status, "running")));
    }

    /** Update a case; a new `data` or `dedupeKey` brings its `title` and `reportedAs` along. */
    static async update(id: bigint, values: Partial<typeof submissions.$inferInsert>) {
        const db = await getDb();
        const derived: SQLiteUpdateSetSource<typeof submissions> = {};
        if (values.data && !("reportedAs" in values)) derived.reportedAs = submissionReportedAs(values.data);
        if ((values.data || values.dedupeKey) && !("title" in values)) {
            const dedupeKey: SQL | string = values.dedupeKey ?? sql`${submissions.dedupeKey}`;
            // A new dedupe key alone renames only a case named by its key: read its stored URL or subject.
            derived.title = values.data
                ? titleOf(values.data) ?? dedupeKey
                : sql`coalesce(nullif(json_extract(${submissions.data}, '$.website.url'), ''), nullif(json_extract(${submissions.data}, '$.email.subject'), ''), ${dedupeKey})`;
        }
        await db
            .update(submissions)
            .set({ ...values, ...derived, updatedAt: new Date() })
            .where(eq(submissions.id, id));
    }

	/** The newest submissions' ids and change times, for the sitemap. */
	static async listSitemapEntries(limit: number) {
		const db = await getDb();
		return db
			.select({ id: submissions.id, createdAt: submissions.createdAt, updatedAt: submissions.updatedAt })
			.from(submissions)
			.orderBy(desc(submissions.createdAt))
			.limit(limit);
	}

	/**
	 * One page of the public list's tiles, newest first, each placed where its
	 * newest case is. The cases of a campaign are one tile; a case in no
	 * campaign joins the campaign whose members all share its site group (a
	 * host still queued beside its reported domain), else its site group's
	 * tile. Only cases of `statuses` count (every status when absent). Tiles
	 * whose newest case is older than `before` (creation time, then id) follow
	 * the previous page with no gaps or repeats. Reads only the columns of
	 * `submissions_list_covering_idx`, never a case's data.
	 */
	static async listTiles(params: { limit: number; before?: { createdAt: Date; id: bigint }; statuses?: readonly SubmissionStatus[] }): Promise<SubmissionTileRow[]> {
		const { before, statuses } = params;
		if (statuses?.length === 0) return [];
		const db = await getDb();
		const statusFilter = statuses ? sql`where s.status in (${sql.join(statuses.map((status) => sql`${status}`), sql`, `)})` : sql``;
		const beforeFilter = before ? sql`where t.newest < ${newestKey(sql`${before.createdAt.getTime()}`, sql`${before.id}`)}` : sql``;
		// Both lookups of submissions are forced onto covering indexes: SQLite without
		// statistics would read the rows, and a row's columns after its (large) data
		// are only reached through the data's overflow pages.
		const rows = db.all<RawTileRow>(sql`
			with direct as materialized (
				-- A case is a member once per confirmed site; it stands for the campaign of its first site (the bare column of min()).
				select submission_id, campaign_id, min(report_id) from campaign_members group by submission_id
			),
			filtered as materialized (
				select s.id, s.kind, s.status, s.created_at, s.site_group, s.title, s.reported_as, d.campaign_id as direct_campaign_id
				from submissions as s indexed by submissions_list_covering_idx
				left join direct as d on d.submission_id = s.id
				${statusFilter}
			),
			campaign_info as materialized (
				select cm.campaign_id, count(*) as site_count, count(distinct cm.submission_id) as host_count,
					count(distinct m.site_group) as group_count, min(m.site_group) as only_group
				from campaign_members as cm
				join submissions as m indexed by submissions_id_site_group_idx on m.id = cm.submission_id
				where cm.campaign_id in (select direct_campaign_id from filtered where direct_campaign_id is not null)
				group by cm.campaign_id
			),
			domain_campaigns as (
				select only_group as site_group, min(campaign_id) as campaign_id
				from campaign_info
				where group_count = 1 and only_group is not null
				group by only_group
			),
			keyed as (
				select f.*, coalesce(f.direct_campaign_id, dc.campaign_id) as campaign_id
				from filtered as f
				left join domain_campaigns as dc on f.direct_campaign_id is null and dc.site_group = f.site_group
			),
			tiles as (
				-- The only max() of the query: the bare columns are those of the tile's newest case.
				select k.id, k.kind, k.status, k.created_at, k.title, k.reported_as, k.site_group, k.campaign_id,
					max(${newestKey(sql`k.created_at`, sql`k.id`)}) as newest,
					count(*) as matched_count,
					sum(k.status = 'running') as running_count,
					sum(k.status = 'queued') as queued_count
				from keyed as k
				-- A tile is its campaign, else its site group, else the case alone.
				group by k.campaign_id, iif(k.campaign_id is null, k.site_group, null), iif(k.campaign_id is null and k.site_group is null, k.id, null)
			)
			select t.id, t.kind, t.status, t.created_at, t.title, t.reported_as, t.site_group, t.campaign_id,
				t.matched_count, t.running_count, t.queued_count,
				ci.site_count, ci.host_count, ci.group_count, ci.only_group
			from tiles as t
			left join campaign_info as ci on ci.campaign_id = t.campaign_id
			${beforeFilter}
			order by t.newest desc
			limit ${params.limit}
		`);
		return rows.map((row) => ({
			id: row.id,
			kind: row.kind,
			status: row.status,
			createdAt: new Date(Number(row.created_at)),
			title: row.title,
			reportedAs: row.reported_as,
			siteGroup: row.site_group,
			campaignId: row.campaign_id,
			matchedCount: Number(row.matched_count),
			runningCount: Number(row.running_count),
			queuedCount: Number(row.queued_count),
			campaignSiteCount: nullableNumber(row.site_count),
			campaignHostCount: nullableNumber(row.host_count),
			campaignDomain: row.group_count === 1n ? row.only_group : null,
		}));
	}

	/** How many submissions have each status; a status no submission has is absent. */
	static async countByStatus() {
		const db = await getDb();
		return db
			.select({ status: submissions.status, count: sql<number>`count(*)` })
			.from(submissions)
			.groupBy(submissions.status);
	}

    static async get(id: bigint) {
        const db = await getDb();
        const [row] = await db.select().from(submissions).where(eq(submissions.id, id));
        return row;
    }

	/** The website cases of a site group, oldest first. */
	static async listSiteGroupCases(siteGroup: string) {
		const db = await getDb();
		return db.select().from(submissions)
			.where(and(eq(submissions.kind, "website"), eq(submissions.siteGroup, siteGroup)))
			.orderBy(submissions.createdAt)
			.all();
	}

	/** Website cases that wait for a visit: queued or running, or failed with an automatic retry scheduled. */
	static async listAwaitingWebsiteVisits() {
		const db = await getDb();
		return db
			.select()
			.from(submissions)
			.where(and(
				eq(submissions.kind, "website"),
				or(
					inArray(submissions.status, ["queued", "running"]),
					and(eq(submissions.status, "failed"), sql`json_extract(${submissions.data}, '$.website.autoRetry.nextAttemptAt') is not null`),
				),
			))
			.orderBy(submissions.createdAt)
			.all();
	}

	/**
	 * Set one field of a website submission's data in place, so a slow job
	 * never writes back what others changed meanwhile. A route's funnel
	 * verdict changes what the case is reported for: `reportedAs` follows it
	 * in the same transaction.
	 */
	static async setWebsiteField(id: bigint, field: "urlscanKit" | "accessGate" | `routes[${number}].funnel`, value: unknown) {
		const db = await getDb();
		db.transaction((tx) => {
			const row = tx
				.update(submissions)
				.set({ data: sql`json_set(${submissions.data}, ${`$.website.${field}`}, json(${JSON.stringify(value)}))`, updatedAt: new Date() })
				.where(eq(submissions.id, id))
				.returning({ data: submissions.data })
				.get();
			if (row && field.endsWith(".funnel")) tx.update(submissions).set({ reportedAs: submissionReportedAs(row.data) }).where(eq(submissions.id, id)).run();
		}, { behavior: "immediate" });
	}

	/** The submission a dedupe key already belongs to, e.g. a website's site. */
	static async findIdByDedupeKey(dedupeKey: string): Promise<bigint | undefined> {
		const db = await getDb();
		const [row] = await db.select({ id: submissions.id }).from(submissions).where(eq(submissions.dedupeKey, dedupeKey)).limit(1);
		return row?.id;
	}

    /**
     * Finds a submission created from a given source.
     * Useful for sources like `imap:<account>:<mailbox>:<uidValidity>:<uid>` that may also create derived submissions like
     * `imap:<account>:<mailbox>:<uidValidity>:<uid>:att1`.
     */
    static async findIdBySourcePrefix(sourcePrefix: string): Promise<bigint | undefined> {
        const db = await getDb();
        const [row] = await db
            .select({ id: submissions.id })
            .from(submissions)
            .where(or(eq(submissions.source, sourcePrefix), sql`${submissions.source} like ${sourcePrefix + ":%"}`))
            .limit(1);
        return row?.id;
    }
}
