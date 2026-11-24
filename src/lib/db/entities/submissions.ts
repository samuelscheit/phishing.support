import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { getDb } from "../index";
import { analysisRuns, submissions, type SubmissionData, type SubmissionKind, type SubmissionStatus } from "../schema";
import { generateId } from "../ids";
import type { ReporterMetadata } from "../../http/reporter_headers";

export class SubmissionsEntity {
    static async create(params: {
        kind: SubmissionKind;
        source?: string;
        data: SubmissionData;
        dedupeKey: string;
        status?: SubmissionStatus;
        info?: string;
        id?: bigint;
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
                    updatedAt: new Date(),
                },
            ])
            .returning({ id: submissions.id });
        return row!.id;
    }

    /** Atomically claim a submission for a state transition. */
    static async transitionStatus(id: bigint, from: SubmissionStatus, to: SubmissionStatus, info?: string): Promise<boolean> {
        const db = await getDb();
        const rows = await db
            .update(submissions)
            .set({ status: to, info, updatedAt: new Date() })
            .where(and(eq(submissions.id, id), eq(submissions.status, from)))
            .returning({ id: submissions.id });
        return rows.length === 1;
    }

    static async failAllRunning(params?: { info?: string }) {
        const db = await getDb();
        const info = params?.info ?? "Marked as failed (previous run did not complete).";
        const now = new Date();
        const rows = await db
            .update(submissions)
            .set({ status: "failed", info, updatedAt: now })
            .where(eq(submissions.status, "running"))
            .returning({ id: submissions.id });
        await db
            .update(analysisRuns)
            .set({
                status: "failed",
                data: {
                    lastError: info,
                    failedAt: now.toISOString(),
                },
            })
            .where(eq(analysisRuns.status, "running"));
        return rows;
    }

    static async update(id: bigint, values: Partial<typeof submissions.$inferInsert>) {
        const db = await getDb();
        await db
            .update(submissions)
            .set({ ...values, updatedAt: new Date() })
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
	 * One page of the public submission list, newest first, holding only what a
	 * card shows. Rows older than `before` (creation time, then id) follow the
	 * previous page with no gaps or repeats while new submissions arrive.
	 * `statuses` keeps only those; absent, every status is listed.
	 */
	static async listCards(params: { limit: number; before?: { createdAt: Date; id: bigint }; statuses?: readonly SubmissionStatus[] }) {
		const db = await getDb();
		const { before, statuses } = params;
		// A case is a member once per confirmed site; its card stands for the campaign of its first site.
		const caseCampaign = sql`(select own.campaign_id from campaign_members as own where own.submission_id = ${submissions.id} order by own.report_id limit 1)`;
		return db
			.select({
				id: submissions.id,
				kind: submissions.kind,
				status: submissions.status,
				createdAt: submissions.createdAt,
				title: sql<string | null>`coalesce(json_extract(${submissions.data}, '$.website.url'), nullif(json_extract(${submissions.data}, '$.email.subject'), ''), ${submissions.dedupeKey})`,
				campaignId: sql<bigint | null>`${caseCampaign}`,
				campaignSize: sql<number | null>`(select count(*) from campaign_members as peers where peers.campaign_id = ${caseCampaign})`,
				// A case reported only for the deceptive funnel a route of it is, with no phishing or malware site on any route.
				funnelOnly: sql<number>`(exists (select 1 from json_each(${submissions.data}, '$.website.routes') as walked where json_extract(walked.value, '$.funnel.verdict.finding') = 'deceptive_funnel') and not exists (select 1 from json_each(${submissions.data}, '$.website.routes') as walked, json_each(walked.value, '$.siteAssessments') as assessed where json_extract(assessed.value, '$.finding') in ('phishing', 'malware')))`,
			})
			.from(submissions)
			.where(and(
				before
					? or(lt(submissions.createdAt, before.createdAt), and(eq(submissions.createdAt, before.createdAt), lt(submissions.id, before.id)))
					: undefined,
				statuses ? inArray(submissions.status, [...statuses]) : undefined,
			))
			.orderBy(desc(submissions.createdAt), desc(submissions.id))
			.limit(params.limit);
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

	/** Failed website analyses whose automatic retry is due. */
	static async listDueWebsiteAutoRetries(now: Date, limit = 10) {
		const db = await getDb();
		return db
			.select({ id: submissions.id })
			.from(submissions)
			.where(and(
				eq(submissions.kind, "website"),
				eq(submissions.status, "failed"),
				sql`json_extract(${submissions.data}, '$.website.autoRetry.nextAttemptAt') <= ${now.toISOString()}`,
			))
			.orderBy(submissions.createdAt)
			.limit(limit);
	}

	/**
	 * Set one field of a website submission's data in place, so a slow job
	 * never writes back what others changed meanwhile.
	 */
	static async setWebsiteField(id: bigint, field: "urlscanKit" | "accessGate" | `routes[${number}].funnel`, value: unknown) {
		const db = await getDb();
		await db
			.update(submissions)
			.set({ data: sql`json_set(${submissions.data}, ${`$.website.${field}`}, json(${JSON.stringify(value)}))`, updatedAt: new Date() })
			.where(eq(submissions.id, id));
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
