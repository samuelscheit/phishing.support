import crypto from "node:crypto";

import { and, desc, eq, inArray, or, sql } from "drizzle-orm";

import { getDb } from "./index";
import {
    analysisRuns,
    artifacts,
    mailIngest,
    providerReports,
    reportMessages,
    reportThreads,
    type MailIngestRoute,
    type ProviderReport,
    type ProviderReportStatus,
    type ReportMessageKind,
    type ReportThreadStatus,
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

function normalizeProviderOperationKey(value: string): string {
	const operationKey = value.trim();
	if (!operationKey || operationKey.length > 512 || /[\u0000\r\n]/.test(operationKey)) {
		throw new Error("Provider operation key must be a non-empty single-line value of at most 512 characters.");
	}
	return operationKey;
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

type ExternalProviderReportTerminalStatus = Extract<ProviderReportStatus, "sent" | "failed" | "unknown_external_state">;

/** Direct provider reports, including durable no-replay submission boundaries. */
export class ProviderReportsEntity {
    static async listForSubmission(submissionId: bigint) {
        const db = await getDb();
        return await db
            .select()
            .from(providerReports)
            .where(eq(providerReports.submissionId, submissionId))
            .orderBy(desc(providerReports.createdAt));
    }

    static async create(params: {
        submissionId: bigint;
        analysisRunId?: bigint;
        channel?: string;
		operationKey?: string;
        to: string;
        subject?: string;
        body: string;
        attachmentsArtifactIds?: Array<bigint | string>;
        status?: ProviderReportStatus;
        sentAt?: Date;
        providerMessageId?: string;
		providerSubmissionUrl?: string;
		error?: string;
        data?: unknown;
        legacy?: boolean;
    }) {
        const db = await getDb();
        const id = generateId();
		const status = params.status ?? "sent";
		const timestamp = nowDate();
        const [row] = await db
            .insert(providerReports)
            .values([
                {
                    id,
                    submissionId: params.submissionId,
                    analysisRunId: params.analysisRunId,
                    channel: params.channel ?? "provider",
					operationKey: params.operationKey,
                    to: params.to,
                    subject: params.subject,
                    body: params.body,
                    status,
                    sentAt: params.sentAt ?? (status === "sent" ? timestamp : undefined),
                    attachmentsArtifactIds: params.attachmentsArtifactIds?.map((value) => value.toString()),
                    createdAt: timestamp,
                    updatedAt: timestamp,
                    providerMessageId: params.providerMessageId,
					providerSubmissionUrl: params.providerSubmissionUrl,
					error: params.error,
                    data: params.data,
                    legacy: params.legacy ?? false,
                },
            ])
            .returning({ id: providerReports.id });
        return row!.id;
    }

	/**
	 * Atomically create and mark an external provider operation immediately
	 * before its irreversible network call. A repeated invocation can observe
	 * a terminal or ambiguous row, but can never acquire a second send right.
	 */
	static async beginExternalSubmission(params: {
		submissionId: bigint;
		analysisRunId?: bigint;
		operationKey: string;
		channel: string;
		to: string;
		subject?: string;
		body: string;
		attachmentsArtifactIds?: Array<bigint | string>;
		data?: unknown;
	}): Promise<{ report: ProviderReport; started: boolean }> {
		const operationKey = normalizeProviderOperationKey(params.operationKey);

		const db = await getDb();
		return db.transaction(
			(tx) => {
				let report = tx.select().from(providerReports).where(eq(providerReports.operationKey, operationKey)).get();
				if (report && (report.submissionId !== params.submissionId || report.channel !== params.channel)) {
					throw new Error("Provider operation key belongs to a different report operation.");
				}

				if (!report) {
					const timestamp = nowDate();
					const id = generateId();
					tx.insert(providerReports)
						.values({
							id,
							submissionId: params.submissionId,
							analysisRunId: params.analysisRunId,
							channel: params.channel,
							operationKey,
							to: params.to,
							subject: params.subject,
							body: params.body,
							status: "pending",
							attachmentsArtifactIds: params.attachmentsArtifactIds?.map((value) => value.toString()),
							data: params.data,
							legacy: false,
							createdAt: timestamp,
							updatedAt: timestamp,
						})
						.run();
					report = tx.select().from(providerReports).where(eq(providerReports.id, id)).get();
				}

				if (!report) throw new Error("Failed to persist the provider submission boundary.");
				if (report.status !== "pending") return { report, started: false };

				const [started] = tx
					.update(providerReports)
					.set({ status: "submission_started", updatedAt: nowDate() })
					.where(and(eq(providerReports.id, report.id), eq(providerReports.status, "pending")))
					.returning()
					.all();
				return started ? { report: started, started: true } : { report, started: false };
			},
			{ behavior: "immediate" },
		);
	}

	/** Record a local preflight failure without crossing an external boundary. */
	static async recordExternalSubmissionFailure(params: {
		submissionId: bigint;
		analysisRunId?: bigint;
		operationKey: string;
		channel: string;
		to: string;
		subject?: string;
		body: string;
		attachmentsArtifactIds?: Array<bigint | string>;
		data?: unknown;
		error: string;
	}): Promise<ProviderReport> {
		const operationKey = normalizeProviderOperationKey(params.operationKey);

		const db = await getDb();
		return db.transaction(
			(tx) => {
				const existing = tx.select().from(providerReports).where(eq(providerReports.operationKey, operationKey)).get();
				if (existing) {
					if (existing.submissionId !== params.submissionId || existing.channel !== params.channel) {
						throw new Error("Provider operation key belongs to a different report operation.");
					}
					return existing;
				}

				const timestamp = nowDate();
				const id = generateId();
				tx.insert(providerReports)
					.values({
						id,
						submissionId: params.submissionId,
						analysisRunId: params.analysisRunId,
						channel: params.channel,
						operationKey,
						to: params.to,
						subject: params.subject,
						body: params.body,
						status: "failed",
						attachmentsArtifactIds: params.attachmentsArtifactIds?.map((value) => value.toString()),
						data: params.data,
						error: params.error,
						legacy: false,
						createdAt: timestamp,
						updatedAt: timestamp,
					})
					.run();
				const report = tx.select().from(providerReports).where(eq(providerReports.id, id)).get();
				if (!report) throw new Error("Failed to persist provider preflight failure.");
				return report;
			},
			{ behavior: "immediate" },
		);
	}

	/** Settle a call only while it still owns the durable pre-call marker. */
	static async settleExternalSubmission(params: {
		reportId: bigint;
		status: ExternalProviderReportTerminalStatus;
		providerMessageId?: string;
		providerSubmissionUrl?: string;
		error?: string;
	}): Promise<boolean> {
		const db = await getDb();
		const timestamp = nowDate();
		const [settled] = await db
			.update(providerReports)
			.set({
				status: params.status,
				sentAt: params.status === "sent" ? timestamp : null,
				providerMessageId: params.providerMessageId ?? null,
				providerSubmissionUrl: params.providerSubmissionUrl ?? null,
				error: params.error ?? null,
				updatedAt: timestamp,
			})
			.where(and(eq(providerReports.id, params.reportId), eq(providerReports.status, "submission_started")))
			.returning({ id: providerReports.id })
			.all();
		return Boolean(settled);
	}
}

/** Per-SMTP-report correspondence thread records. */
export class ReportThreadsEntity {
    /**
     * Creates both durable outbound records in one transaction before any MIME
     * work or SMTP call. This makes a reply routable immediately and prevents
     * orphaned pending threads if the message insert fails.
     */
    static async createWithPendingOutbound(params: {
        submissionId: bigint;
        analysisRunId?: bigint;
        to: string[];
        subject?: string;
        replyAddress: string;
        replyToken: string;
        data?: unknown;
        from: string;
        textBody: string;
        rfcMessageId: string;
    }) {
        const db = await getDb();
        const threadId = generateId();
        const messageId = generateId();
        const timestamp = nowDate();

        db.transaction((tx) => {
            tx.insert(reportThreads)
                .values({
                    id: threadId,
                    submissionId: params.submissionId,
                    analysisRunId: params.analysisRunId,
                    to: params.to,
                    subject: params.subject,
                    replyAddress: params.replyAddress,
                    replyToken: params.replyToken,
                    status: "pending",
                    data: params.data,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                })
                .run();
            tx.insert(reportMessages)
                .values({
                    id: messageId,
                    threadId,
                    direction: "outbound",
                    kind: "report",
                    status: "pending",
                    from: params.from,
                    to: params.to,
                    cc: [],
                    subject: params.subject,
                    textBody: params.textBody,
                    messageId: params.rfcMessageId,
                    references: [],
                    attachmentArtifactIds: [],
                    occurredAt: timestamp,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                })
                .run();
        });

        return { threadId, messageId };
    }

    static async listForSubmission(submissionId: bigint) {
        const db = await getDb();
        return await db
            .select()
            .from(reportThreads)
            .where(eq(reportThreads.submissionId, submissionId))
            .orderBy(desc(reportThreads.createdAt));
    }

    static async findByReplyAddresses(replyAddresses: readonly string[]) {
        if (replyAddresses.length === 0) return [];
        const db = await getDb();
        return await db.select().from(reportThreads).where(inArray(reportThreads.replyAddress, [...replyAddresses]));
    }

    static async findByReplyTokens(replyTokens: readonly string[]) {
		if (replyTokens.length === 0) return [];
        const db = await getDb();
        return await db.select().from(reportThreads).where(inArray(reportThreads.replyToken, [...replyTokens]));
    }

    static async get(threadId: bigint) {
        const db = await getDb();
        const [thread] = await db.select().from(reportThreads).where(eq(reportThreads.id, threadId));
        return thread;
    }

}

export class ReportMessagesEntity {
    static async setOutboundArtifacts(messageId: bigint, params: { rawArtifactId: bigint; attachmentArtifactIds: Array<bigint | string> }) {
        const db = await getDb();
        await db
            .update(reportMessages)
            .set({
                rawArtifactId: params.rawArtifactId,
                attachmentArtifactIds: params.attachmentArtifactIds.map((value) => value.toString()),
                updatedAt: nowDate(),
            })
            .where(eq(reportMessages.id, messageId));
    }

    /** Atomically settles the message transport result without clobbering a received reply. */
    static async settleOutbound(params: {
        threadId: bigint;
        messageId: bigint;
        result: "sent" | "failed";
        providerMessageId?: string;
        error?: string;
    }) {
        const db = await getDb();
        const timestamp = nowDate();

        db.transaction((tx) => {
            if (params.result === "sent") {
                tx.update(reportMessages)
                    // occurredAt is the report's original creation/send position in
                    // the conversation. Settlement can happen after an immediate
                    // reply has already been ingested, so changing it here would
                    // reorder the outbound report after that reply in the timeline.
                    .set({ status: "sent", sentAt: timestamp, providerMessageId: params.providerMessageId, error: null, updatedAt: timestamp })
                    .where(and(eq(reportMessages.id, params.messageId), eq(reportMessages.status, "pending")))
                    .run();
                tx.update(reportThreads)
                    .set({ status: "sent", updatedAt: timestamp })
                    .where(and(eq(reportThreads.id, params.threadId), eq(reportThreads.status, "pending")))
                    .run();
                return;
            }

            tx.update(reportMessages)
                .set({ status: "failed", error: params.error ?? "SMTP transport failed.", updatedAt: timestamp })
                .where(and(eq(reportMessages.id, params.messageId), eq(reportMessages.status, "pending")))
                .run();
            tx.update(reportThreads)
                .set({ status: "failed", updatedAt: timestamp })
                .where(and(eq(reportThreads.id, params.threadId), eq(reportThreads.status, "pending")))
                .run();
        });
    }

    static async findThreadsByOutboundMessageIds(messageIds: readonly string[]) {
        if (messageIds.length === 0) return [];
        const db = await getDb();
        return await db
            .select({ threadId: reportMessages.threadId, messageId: reportMessages.messageId })
            .from(reportMessages)
            .where(and(eq(reportMessages.direction, "outbound"), inArray(reportMessages.messageId, [...messageIds])));
    }

    static async listForThread(threadId: bigint) {
        const db = await getDb();
        return await db
            .select()
            .from(reportMessages)
            .where(eq(reportMessages.threadId, threadId))
            .orderBy(reportMessages.occurredAt, reportMessages.createdAt);
    }

    static async listForThreads(threadIds: readonly bigint[]) {
        if (threadIds.length === 0) return [];
        const db = await getDb();
        return await db
            .select()
            .from(reportMessages)
            .where(inArray(reportMessages.threadId, [...threadIds]))
            .orderBy(reportMessages.occurredAt, reportMessages.createdAt);
    }

	/**
	 * Returns an existing inbound message with this RFC Message-ID regardless of
	 * thread. Mail transfer agents occasionally duplicate a delivery into a
	 * different folder/UID; a single RFC message must never create two pieces of
	 * correspondence just because it reached IMAP twice.
	 */
	static async findInboundByMessageId(messageId: string | undefined) {
		if (!messageId) return undefined;
		const db = await getDb();
		const [message] = await db
			.select({ id: reportMessages.id, threadId: reportMessages.threadId })
			.from(reportMessages)
			.where(and(eq(reportMessages.direction, "inbound"), eq(reportMessages.messageId, messageId)))
			.limit(1);
		return message;
	}

    /**
     * Commits the correspondence message, its thread status, and the IMAP UID
     * disposition in one SQLite transaction. Artifact bytes are saved first and
     * linked by ID here, so a listener retry cannot create a second message.
     */
    static async persistInboundWithIngest(params: {
        threadId: bigint;
        kind: Exclude<ReportMessageKind, "report">;
        from?: string;
        to: string[];
        cc?: string[];
        subject?: string;
        textBody?: string;
        htmlBody?: string | null;
        messageId?: string;
        inReplyTo?: string;
        references?: string[];
        rawArtifactId?: bigint;
        attachmentArtifactIds?: Array<bigint | string>;
        occurredAt?: Date;
        mailbox: string;
        uidValidity: number;
        uid: number;
        rawMessageId?: string;
        ingestReason?: string;
    }) {
        const db = await getDb();
        const id = generateId();
		const timestamp = nowDate();
		const threadStatus: ReportThreadStatus = params.kind === "bounce" ? "delivery_failed" : "replied";
		const allowedThreadStatuses: ReportThreadStatus[] =
			params.kind === "bounce" ? ["pending", "sent", "failed"] : ["pending", "sent", "failed", "delivery_failed"];

		const persisted = db.transaction((tx) => {
            const existingIngest = tx
                .select({ id: mailIngest.id, terminal: mailIngest.terminal })
                .from(mailIngest)
                .where(and(eq(mailIngest.mailbox, params.mailbox), eq(mailIngest.uidValidity, params.uidValidity), eq(mailIngest.uid, params.uid)))
                .get();
            if (existingIngest?.terminal) return false;

            const ingestId = existingIngest?.id ?? generateId();
			if (existingIngest) {
                // A prior parsing/storage failure is retryable. Its terminal
                // disposition is only set after the correspondence write below.
                tx.update(mailIngest)
					.set({
						messageId: params.rawMessageId,
						route: "reply",
						reason: params.ingestReason,
						attempts: sql`${mailIngest.attempts} + 1`,
						terminal: false,
                        processedAt: timestamp,
                        updatedAt: timestamp,
                    })
                    .where(eq(mailIngest.id, ingestId))
                    .run();
            } else {
                tx.insert(mailIngest)
                    .values({
                        id: ingestId,
                        mailbox: params.mailbox,
                        uidValidity: params.uidValidity,
                        uid: params.uid,
                        messageId: params.rawMessageId,
                        route: "reply",
                        reason: params.ingestReason,
                        attempts: 1,
                        terminal: false,
                        processedAt: timestamp,
                        createdAt: timestamp,
                        updatedAt: timestamp,
                    })
                    .onConflictDoNothing()
                    .run();

                const concurrentlyStoredIngest = tx
                    .select({ id: mailIngest.id, terminal: mailIngest.terminal })
                    .from(mailIngest)
                    .where(
                        and(
                            eq(mailIngest.mailbox, params.mailbox),
                            eq(mailIngest.uidValidity, params.uidValidity),
                            eq(mailIngest.uid, params.uid),
                        ),
                    )
                    .get();
                if (!concurrentlyStoredIngest || concurrentlyStoredIngest.id !== ingestId) return false;
            }

			const existingMessage = params.messageId
				? tx
						.select({ id: reportMessages.id, threadId: reportMessages.threadId })
						.from(reportMessages)
						.where(and(eq(reportMessages.direction, "inbound"), eq(reportMessages.messageId, params.messageId)))
						.limit(1)
						.get()
				: undefined;
			if (existingMessage) {
					tx.update(mailIngest)
					.set({
						reportMessageId: existingMessage.id,
						reason: "duplicate_message_id",
						terminal: true,
						processedAt: timestamp,
						updatedAt: timestamp,
					})
					.where(eq(mailIngest.id, ingestId))
					.run();
				return false;
			}

			const [storedMessage] = tx
				.insert(reportMessages)
                .values({
                    id,
                    threadId: params.threadId,
                    direction: "inbound",
                    kind: params.kind,
                    status: "received",
                    from: params.from,
                    to: params.to,
                    cc: params.cc ?? [],
                    subject: params.subject,
                    textBody: params.textBody,
                    htmlBody: params.htmlBody ?? undefined,
                    messageId: params.messageId,
                    inReplyTo: params.inReplyTo,
                    references: params.references ?? [],
                    rawArtifactId: params.rawArtifactId,
                    attachmentArtifactIds: params.attachmentArtifactIds?.map((value) => value.toString()) ?? [],
                    occurredAt: params.occurredAt ?? timestamp,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                })
				.onConflictDoNothing()
				.returning({ id: reportMessages.id })
				.all();
			if (!storedMessage) {
				const duplicate = params.messageId
					? tx
							.select({ id: reportMessages.id })
							.from(reportMessages)
							.where(and(eq(reportMessages.direction, "inbound"), eq(reportMessages.messageId, params.messageId)))
							.limit(1)
							.get()
					: undefined;
				if (!duplicate) throw new Error("Failed to persist inbound report message.");
					tx.update(mailIngest)
					.set({
						reportMessageId: duplicate.id,
						reason: "duplicate_message_id",
						terminal: true,
						processedAt: timestamp,
						updatedAt: timestamp,
					})
					.where(eq(mailIngest.id, ingestId))
					.run();
				return false;
			}
            tx.update(reportThreads)
                .set({ status: threadStatus, updatedAt: timestamp })
                .where(and(eq(reportThreads.id, params.threadId), inArray(reportThreads.status, allowedThreadStatuses)))
                .run();
			tx.update(mailIngest)
				.set({ reportMessageId: storedMessage.id, terminal: true, processedAt: timestamp, updatedAt: timestamp })
                .where(eq(mailIngest.id, ingestId))
                .run();
            return true;
        });
        return persisted ? id : undefined;
    }
}

/** IMAP UID ledger: terminal rows are idempotency records; failed rows are retryable. */
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
        reportMessageId?: bigint;
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
                    reportMessageId: params.reportMessageId,
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
					reportMessageId: params.reportMessageId,
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

/** Read model used by analysis workflows to avoid treating pending or failed mail as reported. */
export class ReportingSummaryEntity {
    static async hasSuccessfulReport(submissionId: bigint): Promise<boolean> {
        const db = await getDb();
        const [provider] = await db
            .select({ id: providerReports.id })
            .from(providerReports)
            .where(and(eq(providerReports.submissionId, submissionId), eq(providerReports.status, "sent")))
            .limit(1);
        if (provider) return true;

        const [thread] = await db
            .select({ id: reportMessages.id })
            .from(reportMessages)
            .innerJoin(reportThreads, eq(reportMessages.threadId, reportThreads.id))
            .where(
                and(
                    eq(reportThreads.submissionId, submissionId),
                    eq(reportMessages.direction, "outbound"),
                    eq(reportMessages.kind, "report"),
                    eq(reportMessages.status, "sent"),
                ),
            )
            .limit(1);
        return Boolean(thread);
    }
}
