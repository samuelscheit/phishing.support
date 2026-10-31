import crypto from "node:crypto";

import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";

import { getDb } from "./index";
import {
    analysisRuns,
    artifacts,
    mailIngest,
    type MailIngestRoute,
    submissions,
    type SubmissionData,
    type SubmissionKind,
    type SubmissionStatus,
    type AnalysisRunKind,
} from "./schema";
import { ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses.mjs";
import { generateId } from "./ids";
import type { ReporterMetadata } from "../request_metadata";
import { websiteEvidenceFiles, type WebsiteEvidencePackage } from "../evidence/package";

function nowDate(): Date {
    return new Date();
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
                    await db.update(submissions).set({ ...metadata, updatedAt: nowDate() }).where(eq(submissions.id, existing.id));
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
                    status: params.status ?? "new",
                    info: params.info,
                    reporterIp: params.reporterIp,
                    reporterCountry: params.reporterCountry,
                    reporterHeaders: params.reporterHeaders,
                    updatedAt: nowDate(),
                },
            ])
            .returning({ id: submissions.id });
        return row!.id;
    }

    static async setStatus(id: bigint, status: SubmissionStatus, info?: string) {
        const db = await getDb();
        await db.update(submissions).set({ status, info, updatedAt: nowDate() }).where(eq(submissions.id, id));
    }

    /** Atomically claim a submission for a state transition. */
    static async transitionStatus(id: bigint, from: SubmissionStatus, to: SubmissionStatus, info?: string): Promise<boolean> {
        const db = await getDb();
        const rows = await db
            .update(submissions)
            .set({ status: to, info, updatedAt: nowDate() })
            .where(and(eq(submissions.id, id), eq(submissions.status, from)))
            .returning({ id: submissions.id });
        return rows.length === 1;
    }

    static async failAllRunning(params?: { info?: string }) {
        const db = await getDb();
        const info = params?.info ?? "Marked as failed (previous run did not complete).";
        const now = nowDate();
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
            .set({ ...values, updatedAt: nowDate() })
            .where(eq(submissions.id, id));
    }

    static async list(limit: number = 50) {
        const db = await getDb();
        return await db.select().from(submissions).orderBy(desc(submissions.createdAt)).limit(limit);
    }

	/**
	 * One page of the public submission list, newest first, holding only what a
	 * card shows. Rows older than `before` (creation time, then id) follow the
	 * previous page with no gaps or repeats while new submissions arrive.
	 */
	static async listCards(params: { limit: number; before?: { createdAt: Date; id: bigint } }) {
		const db = await getDb();
		const { before } = params;
		return db
			.select({
				id: submissions.id,
				kind: submissions.kind,
				status: submissions.status,
				createdAt: submissions.createdAt,
				title: sql<string | null>`coalesce(json_extract(${submissions.data}, '$.website.url'), nullif(json_extract(${submissions.data}, '$.email.subject'), ''), ${submissions.dedupeKey})`,
			})
			.from(submissions)
			.where(before
				? or(lt(submissions.createdAt, before.createdAt), and(eq(submissions.createdAt, before.createdAt), lt(submissions.id, before.id)))
				: undefined)
			.orderBy(desc(submissions.createdAt), desc(submissions.id))
			.limit(params.limit);
	}

    static async get(id: bigint) {
        const db = await getDb();
        const [row] = await db.select().from(submissions).where(eq(submissions.id, id));
        return row;
    }

	/**
	 * Atomically claim legacy website rows that were persisted before the
	 * analysis worker started.  Current submissions are created as `running`,
	 * so `new` here is recovery state rather than a normal work queue.
	 */
	static async claimPendingWebsiteAnalysis(id: bigint): Promise<boolean> {
		const db = await getDb();
		const rows = await db
			.update(submissions)
			.set({ status: "running", info: "Resuming interrupted website analysis.", updatedAt: nowDate() })
			.where(and(
				eq(submissions.id, id),
				eq(submissions.kind, "website"),
				inArray(submissions.status, ["new", "queued"]),
			))
			.returning({ id: submissions.id });
		return rows.length === 1;
	}

	static async listPendingWebsiteAnalyses(limit = 10) {
		const db = await getDb();
		return db
			.select()
			.from(submissions)
			.where(and(eq(submissions.kind, "website"), inArray(submissions.status, ["new", "queued"])))
			.orderBy(submissions.createdAt)
			.limit(limit);
	}

	/** Failed website analyses whose automatic retry (after a browser-service failure) is due. */
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

export class AnalysisRunsEntity {
    static async create(submissionId: bigint, input?: Array<ResponseInputItem>, analysisKind: AnalysisRunKind = "unknown") {
        const db = await getDb();
        const id = generateId();
        await db.insert(analysisRuns).values([
            {
                id,
                submissionId,
                status: "running" as const,
                analysisKind,
                input: input,
                createdAt: nowDate(),
            },
        ]);

        return id;
    }

    static async update(id: bigint, values: Partial<typeof analysisRuns.$inferInsert>) {
        const db = await getDb();
        await db.update(analysisRuns).set(values).where(eq(analysisRuns.id, id));
    }

    static async listForSubmission(submissionId: bigint) {
        const db = await getDb();
        const result = await db
            .select()
            .from(analysisRuns)
            .orderBy(analysisRuns.createdAt)
            .where(eq(analysisRuns.submissionId, submissionId));

        result.forEach((run) => {
            if (!run.input) return;

            run.input.forEach((item) => {
                if ("content" in item && Array.isArray(item.content)) {
                    item.content = item.content.filter((x) => x.type !== "input_image") as any;
                }
            });
        });

        return result;
    }

    static async complete(runId: bigint, output?: Array<ResponseOutputItem>, tokensUsed?: number) {
        const db = await getDb();
        const result = await db
            .update(analysisRuns)
            .set({
                status: "completed",
                output: output,
                tokensUsed: tokensUsed,
            })
            .where(eq(analysisRuns.id, runId))
            .returning();

        console.log("Analysis run completed:", result);
    }

    static async fail(runId: bigint, data?: unknown) {
        const db = await getDb();
        await db.update(analysisRuns).set({ status: "failed", ...(data === undefined ? {} : { data }) }).where(eq(analysisRuns.id, runId));
    }
}

export class ArtifactsEntity {
    static sha256Hex(buffer: Buffer): string {
        return crypto.createHash("sha256").update(buffer).digest("hex");
    }

    static async saveBuffer(params: {
        submissionId?: bigint;
        name?: string;
        kind: string;
        mimeType?: string;
        archivedAt?: Date;
        buffer: Buffer;
    }) {
        const db = await getDb();
        const id = generateId();
		const [row] = await db
			.insert(artifacts)
            .values([
                {
                    id,
                    submissionId: params.submissionId,
                    name: params.name,
                    kind: params.kind,
                    archivedAt: params.archivedAt,
                    mimeType: params.mimeType,
                    sha256: this.sha256Hex(params.buffer),
                    size: params.buffer.byteLength,
                    blob: params.buffer,
                    createdAt: nowDate(),
                },
            ])
			.returning({ id: artifacts.id });

        return row!.id;
    }

    static async listForSubmission(submissionId: bigint) {
        const db = await getDb();
        return await db
            .select({
                id: artifacts.id,
                name: artifacts.name,
                kind: artifacts.kind,
                mimeType: artifacts.mimeType,
                size: artifacts.size,
                createdAt: artifacts.createdAt,
                archivedAt: artifacts.archivedAt,
                sha256: artifacts.sha256,
            })
            .from(artifacts)
            .where(eq(artifacts.submissionId, submissionId));
    }

    static async get(id: bigint) {
        const db = await getDb();
        const [row] = await db.select().from(artifacts).where(eq(artifacts.id, id));
        return row;
    }

    /**
     * Store a capture with its evidence package: the raw screenshot and MHTML
     * exactly as captured, the screenshot with its address bar, the manifest
     * naming every file by SHA-256, and the RFC 3161 token for that manifest.
     */
    static async saveWebsiteArtifacts({
        archive,
        submissionId,
        evidence,
    }: {
        submissionId: bigint;
        archive: {
            archivedAt: Date;
            screenshotPng?: Buffer;
            mhtml: Buffer;
        };
        evidence?: WebsiteEvidencePackage;
    }) {
        const mhtmlId = await this.saveBuffer({
            submissionId,
            name: "website.mhtml",
            kind: "website_mhtml",
            mimeType: "text/mhtml",
            archivedAt: archive.archivedAt,
            buffer: archive.mhtml,
        });
        const screenshotId = archive.screenshotPng?.byteLength
            ? await this.saveBuffer({
                submissionId,
                name: "website.png",
                kind: "website_png",
                mimeType: "image/png",
                archivedAt: archive.archivedAt,
                buffer: archive.screenshotPng,
            })
            : undefined;
        for (const file of evidence ? websiteEvidenceFiles(evidence) : []) {
            await this.saveBuffer({
                submissionId,
                name: file.name,
                kind: "website_evidence",
                mimeType: file.mimeType,
                archivedAt: archive.archivedAt,
                buffer: file.bytes,
            });
        }

        return {
            screenshotId,
            mhtmlId,
        };
    }
}

/** Idempotency ledger for messages observed in the monitored mailbox. */
export class MailIngestEntity {
    static async get(params: { mailbox: string; uidValidity: number; uid: number }) {
        const db = await getDb();
        const [row] = await db
            .select()
            .from(mailIngest)
            .where(and(eq(mailIngest.mailbox, params.mailbox), eq(mailIngest.uidValidity, params.uidValidity), eq(mailIngest.uid, params.uid)));
        return row;
    }

    static async recordTerminal(params: {
        mailbox: string;
        uidValidity: number;
        uid: number;
        messageId?: string;
        route: Exclude<MailIngestRoute, "failed">;
        reason?: string;
    }) {
        const db = await getDb();
        const timestamp = nowDate();
        await db
            .insert(mailIngest)
            .values([
                {
                    id: generateId(),
                    mailbox: params.mailbox,
                    uidValidity: params.uidValidity,
                    uid: params.uid,
                    messageId: params.messageId,
                    route: params.route,
                    reason: params.reason,
                    attempts: 1,
                    terminal: true,
                    processedAt: timestamp,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                },
            ])
			.onConflictDoUpdate({
				target: [mailIngest.mailbox, mailIngest.uidValidity, mailIngest.uid],
				where: eq(mailIngest.terminal, false),
				set: {
					messageId: params.messageId,
					route: params.route,
					reason: params.reason,
					attempts: sql`${mailIngest.attempts} + 1`,
					terminal: true,
                    processedAt: timestamp,
                    updatedAt: timestamp,
                },
            });
    }

    static async recordFailure(params: { mailbox: string; uidValidity: number; uid: number; messageId?: string; reason: string }) {
        const db = await getDb();
        const timestamp = nowDate();
        await db
            .insert(mailIngest)
            .values([
                {
                    id: generateId(),
                    mailbox: params.mailbox,
                    uidValidity: params.uidValidity,
                    uid: params.uid,
                    messageId: params.messageId,
                    route: "failed",
                    reason: params.reason,
                    attempts: 1,
                    terminal: false,
                    processedAt: timestamp,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                },
            ])
			.onConflictDoUpdate({
				target: [mailIngest.mailbox, mailIngest.uidValidity, mailIngest.uid],
				where: eq(mailIngest.terminal, false),
				set: {
                    messageId: params.messageId,
                    route: "failed",
                    reason: params.reason,
                    attempts: sql`${mailIngest.attempts} + 1`,
                    terminal: false,
                    processedAt: timestamp,
                    updatedAt: timestamp,
                },
            });
    }
}
