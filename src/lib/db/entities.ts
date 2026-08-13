import crypto from "node:crypto";

import { eq, or, sql, desc } from "drizzle-orm";

import { getDb } from "./index";
import {
    analysisRuns,
    artifacts,
    reports,
    ReportStatus,
    submissions,
    type SubmissionData,
    type SubmissionKind,
    type SubmissionStatus,
} from "./schema";
import { ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses.mjs";
import { generateId } from "./ids";
import type { ReporterMetadata } from "../request_metadata";

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

    static async failAllRunning(params?: { info?: string }) {
        const db = await getDb();
        const info = params?.info ?? "Marked as failed (previous run did not complete).";
        const rows = await db
            .update(submissions)
            .set({ status: "failed", info, updatedAt: nowDate() })
            .where(eq(submissions.status, "running"))
            .returning({ id: submissions.id });
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

    static async get(id: bigint) {
        const db = await getDb();
        const [row] = await db.select().from(submissions).where(eq(submissions.id, id));
        return row;
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
    static async create(submissionId: bigint, input?: Array<ResponseInputItem>) {
        const db = await getDb();
        const id = generateId();
        await db.insert(analysisRuns).values([
            {
                id,
                submissionId,
                status: "running" as const,
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

    static async fail(runId: bigint) {
        const db = await getDb();
        await db.update(analysisRuns).set({ status: "failed" }).where(eq(analysisRuns.id, runId));
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
            .returning({ id: artifacts.id })
            .onConflictDoUpdate({
                target: [artifacts.sha256, artifacts.size],
                set: {
                    name: sql.raw(`excluded.${artifacts.name.name}`),
                    kind: sql.raw(`excluded.${artifacts.kind.name}`),
                    mimeType: sql.raw(`excluded.${artifacts.mimeType.name}`),
                    submissionId: sql.raw(`excluded.${artifacts.submissionId.name}`),
                    createdAt: sql.raw(`excluded.${artifacts.createdAt.name}`),
                    archivedAt: sql.raw(`excluded.${artifacts.archivedAt.name}`),
                },
            });

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

    static async saveWebsiteArtifacts({
        archive,
        submissionId,
    }: {
        submissionId: bigint;
        archive: {
            archivedAt: Date;
            screenshotPng: Buffer;
            mhtml: Buffer;
        };
    }) {
        const [screenshotId, mhtmlId] = await Promise.all([
            this.saveBuffer({
                submissionId: submissionId,
                name: `website.png`,
                kind: "website_png",
                mimeType: "image/png",
                archivedAt: archive.archivedAt,
                buffer: archive.screenshotPng,
            }),
            this.saveBuffer({
                submissionId: submissionId,
                name: `website.mhtml`,
                kind: "website_mhtml",
                mimeType: "text/mhtml",
                archivedAt: archive.archivedAt,
                buffer: archive.mhtml,
            }),
        ]);

        return {
            screenshotId,
            mhtmlId,
        };
    }
}

export class ReportsEntity {
    static async listForSubmission(submissionId: bigint) {
        const db = await getDb();
        return await db.select().from(reports).where(eq(reports.submissionId, submissionId));
    }

    static async create(params: {
        submissionId: bigint;
        analysisRunId?: bigint;
        to: string;
        subject?: string;
        body: string;
        attachmentsArtifactIds?: Array<bigint | string>;
        status?: ReportStatus;
        providerMessageId?: string;
        data?: any;
    }) {
        const db = await getDb();
        const id = generateId();
        const [row] = await db
            .insert(reports)
            .values([
                {
                    id,
                    submissionId: params.submissionId,
                    analysisRunId: params.analysisRunId,
                    channel: "email",
                    to: params.to,
                    subject: params.subject,
                    body: params.body,
                    status: params.status ?? "sent",
                    attachmentsArtifactIds: params.attachmentsArtifactIds?.map((value) => value.toString()),
                    createdAt: nowDate(),
                    updatedAt: nowDate(),
                    providerMessageId: params.providerMessageId,
                    data: params.data,
                },
            ])
            .returning({ id: reports.id });
        return row!.id;
    }
}
