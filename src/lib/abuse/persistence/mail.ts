import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "../../db";
import { generateId } from "../../db/ids";
import { abuseJobs, abuseMailMessages, abuseProviderRoutes, type AbuseMailClassification, type AbuseProviderRoute } from "../schema";
import { insertArtifact, now, recordEvent } from "./shared";

class DuplicateInboundMailError extends Error {
	readonly code = "duplicate_inbound_abuse_mail";
}

/**
 * The immutable inbound-message record and its one classifier job form a
 * single durable unit. A completed/failed job is still a record of that
 * message's classification attempt, so duplicate IMAP delivery must not
 * create a second classifier run.
 */
function ensureInboundReplyClassificationInTransaction(tx: any, message: {
	id: bigint;
	reportId: bigint;
	routeId: bigint;
	direction: string;
}) {
	if (message.direction !== "inbound") return;
	const dedupeKey = `classify-abuse-mail:${message.id.toString()}`;
	const existing = tx
		.select({ id: abuseJobs.id })
		.from(abuseJobs)
		.where(eq(abuseJobs.dedupeKey, dedupeKey))
		.get();
	if (existing) return;
	const id = generateId();
	const timestamp = now();
	tx.insert(abuseJobs)
		.values({
			id,
			jobType: "classify_provider_reply",
			reportId: message.reportId,
			routeId: message.routeId,
			payload: { messageId: message.id.toString() },
			dedupeKey,
			status: "queued",
			retryCount: 0,
			nextAttemptAt: timestamp,
			unknownExternalState: false,
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.run();
	recordEvent(tx, {
		reportId: message.reportId,
		routeId: message.routeId,
		jobId: id,
		eventType: "job.queued",
		data: { jobType: "classify_provider_reply" },
	});
}

/** Ensure a recovered/duplicate inbound message has its durable classifier job. */
export async function ensureInboundReplyClassification(messageId: bigint): Promise<void> {
	const db = await getDb();
	await db.transaction(
		(tx) => {
			const message = tx.select().from(abuseMailMessages).where(eq(abuseMailMessages.id, messageId)).get();
			if (message) ensureInboundReplyClassificationInTransaction(tx, message);
		},
		{ behavior: "immediate" },
	);
}

export async function createOutboundMail(params: {
	reportId: bigint;
	routeId: bigint;
	runId: bigint;
	fromAddress: string;
	toAddresses: string[];
	subject: string;
	textBody: string;
	messageId: string;
	replyAddress: string;
	correlationKey: string;
	rawArtifactId: bigint;
	attachmentArtifactIds: bigint[];
}): Promise<bigint> {
	const db = await getDb();
	const id = generateId();
	await db.insert(abuseMailMessages).values({
		id,
		reportId: params.reportId,
		routeId: params.routeId,
		runId: params.runId,
		direction: "outbound",
		kind: "report",
		status: "pending",
		fromAddress: params.fromAddress,
		toAddresses: params.toAddresses,
		subject: params.subject,
		textBody: params.textBody,
		messageId: params.messageId,
		replyAddress: params.replyAddress,
		correlationKey: params.correlationKey,
		rawArtifactId: params.rawArtifactId,
		attachmentArtifactIds: params.attachmentArtifactIds.map(String),
		processingAttempts: 0,
		occurredAt: now(),
		createdAt: now(),
		updatedAt: now(),
	});
	return id;
}

/**
 * Settle an outbound MIME record without allowing a late sender completion
 * to overwrite a correlated delivery failure. A successful SMTP return may
 * race an inbound bounce, so `sent` is legal only from `pending`; a known
 * failure can supersede either pre-send or sent state.
 */

export async function settleOutboundMail(params: { messageId: bigint; status: "sent" | "failed"; error?: string }): Promise<boolean> {
	const db = await getDb();
	const expected = params.status === "sent" ? ["pending"] : ["pending", "sent"];
	const updated = await db
		.update(abuseMailMessages)
		.set({ status: params.status, error: params.error, occurredAt: now(), updatedAt: now() })
		.where(
			and(
				eq(abuseMailMessages.id, params.messageId),
				eq(abuseMailMessages.direction, "outbound"),
				inArray(abuseMailMessages.status, expected),
			),
		)
		.returning({ id: abuseMailMessages.id })
		.get();
	return Boolean(updated);
}

export async function getOutboundMailForRun(runId: bigint) {
	const db = await getDb();
	return db
		.select()
		.from(abuseMailMessages)
		.where(and(eq(abuseMailMessages.runId, runId), eq(abuseMailMessages.direction, "outbound")))
		.orderBy(desc(abuseMailMessages.createdAt))
		.limit(1)
		.get();
}

export async function findCorrelatedInboundRoute(params: { recipients: string[]; inReplyTo?: string; references?: string[] }): Promise<{
	route: AbuseProviderRoute | undefined;
	matched: boolean;
}> {
	const db = await getDb();
	const candidateRouteIds = new Set<bigint>();
	if (params.recipients.length > 0) {
		const byReplyAddress = await db
			.select({ routeId: abuseMailMessages.routeId })
			.from(abuseMailMessages)
			.where(and(eq(abuseMailMessages.direction, "outbound"), inArray(abuseMailMessages.replyAddress, params.recipients)));
		for (const row of byReplyAddress) candidateRouteIds.add(row.routeId);
	}
	const refs = [...new Set([params.inReplyTo, ...(params.references ?? [])].filter((value): value is string => Boolean(value)))];
	if (refs.length > 0) {
		const byMessageId = await db
			.select({ routeId: abuseMailMessages.routeId })
			.from(abuseMailMessages)
			.where(and(eq(abuseMailMessages.direction, "outbound"), inArray(abuseMailMessages.messageId, refs)));
		for (const row of byMessageId) candidateRouteIds.add(row.routeId);
	}
	if (candidateRouteIds.size !== 1) return { route: undefined, matched: candidateRouteIds.size > 0 || refs.length > 0 };
	const routeId = [...candidateRouteIds][0];
	return {
		route: db.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, routeId)).get(),
		matched: true,
	};
}

/**
 * Persist one inbound IMAP delivery and every associated permanent artifact
 * in one transaction. The IMAP UID ledger is checked before any artifact is
 * written, so a repeated delivery cannot leave orphan raw-MIME or attachment
 * records behind. RFC Message-ID is also checked in the same transaction to
 * cover a provider copying one message to a different UID/mailbox.
 */

export async function persistInboundMailWithArtifacts(params: {
	reportId: bigint;
	routeId: bigint;
	kind: string;
	fromAddress?: string;
	toAddresses: string[];
	subject?: string;
	textBody?: string;
	messageId?: string;
	inReplyTo?: string;
	references?: string[];
	mailbox: string;
	uidValidity: number;
	uid: number;
	rawMime: { name: string; buffer: Buffer; metadata?: Record<string, unknown> };
	attachments: Array<{ name: string; mimeType: string; buffer: Buffer; metadata?: Record<string, unknown> }>;
	occurredAt?: Date;
}): Promise<{ id: bigint; created: boolean }> {
	const db = await getDb();
	try {
		return db.transaction(
			(tx) => {
				if (!Number.isSafeInteger(params.uidValidity) || params.uidValidity <= 0 || !Number.isSafeInteger(params.uid) || params.uid <= 0) {
					throw new Error("Inbound abuse mail requires a positive IMAP UID and UIDVALIDITY.");
				}
				const route = tx
					.select({ reportId: abuseProviderRoutes.reportId })
					.from(abuseProviderRoutes)
					.where(eq(abuseProviderRoutes.id, params.routeId))
					.get();
				if (!route || route.reportId !== params.reportId) throw new Error("Inbound abuse mail route does not belong to the supplied report.");
				const existing = tx
					.select({ id: abuseMailMessages.id, reportId: abuseMailMessages.reportId, routeId: abuseMailMessages.routeId, direction: abuseMailMessages.direction })
					.from(abuseMailMessages)
					.where(
						and(
							eq(abuseMailMessages.imapMailbox, params.mailbox),
							eq(abuseMailMessages.imapUidValidity, params.uidValidity),
							eq(abuseMailMessages.imapUid, params.uid),
						),
					)
					.get();
				if (existing) {
					ensureInboundReplyClassificationInTransaction(tx, existing);
					return { id: existing.id, created: false };
				}
				if (params.messageId) {
					const existingMessage = tx
						.select({ id: abuseMailMessages.id, reportId: abuseMailMessages.reportId, routeId: abuseMailMessages.routeId, direction: abuseMailMessages.direction })
						.from(abuseMailMessages)
						.where(and(eq(abuseMailMessages.direction, "inbound"), eq(abuseMailMessages.messageId, params.messageId)))
						.get();
					if (existingMessage) {
						ensureInboundReplyClassificationInTransaction(tx, existingMessage);
						return { id: existingMessage.id, created: false };
					}
				}

				const rawArtifactId = insertArtifact(tx, {
					reportId: params.reportId,
					routeId: params.routeId,
					name: params.rawMime.name,
					kind: "inbound_mail_mime",
					mimeType: "message/rfc822",
					buffer: params.rawMime.buffer,
					metadata: params.rawMime.metadata,
				});
				const attachmentArtifactIds = params.attachments.map((attachment) =>
					insertArtifact(tx, {
						reportId: params.reportId,
						routeId: params.routeId,
						name: attachment.name,
						kind: "inbound_mail_attachment",
						mimeType: attachment.mimeType,
						buffer: attachment.buffer,
						metadata: attachment.metadata,
					}),
				);
				const id = generateId();
				const timestamp = now();
				const inserted = tx
					.insert(abuseMailMessages)
					.values({
						id,
						reportId: params.reportId,
						routeId: params.routeId,
						direction: "inbound",
						kind: params.kind,
						status: "received",
						fromAddress: params.fromAddress,
						toAddresses: params.toAddresses,
						subject: params.subject,
						textBody: params.textBody,
						messageId: params.messageId,
						inReplyTo: params.inReplyTo,
						references: params.references ?? [],
						rawArtifactId,
						attachmentArtifactIds: attachmentArtifactIds.map(String),
						imapMailbox: params.mailbox,
						imapUidValidity: params.uidValidity,
						imapUid: params.uid,
						processingAttempts: 0,
						occurredAt: params.occurredAt ?? timestamp,
						createdAt: timestamp,
						updatedAt: timestamp,
					})
					.onConflictDoNothing()
					.returning({ id: abuseMailMessages.id })
					.get();
				if (!inserted) throw new DuplicateInboundMailError("Inbound abuse mail uniqueness race.");
				recordEvent(tx, { reportId: params.reportId, routeId: params.routeId, eventType: "mail.inbound_received", data: { kind: params.kind } });
				ensureInboundReplyClassificationInTransaction(tx, {
					id: inserted.id,
					reportId: params.reportId,
					routeId: params.routeId,
					direction: "inbound",
				});
				return { id: inserted.id, created: true };
			},
			{ behavior: "immediate" },
		);
	} catch (error) {
		if (!(error instanceof DuplicateInboundMailError)) throw error;
		const existingByUid = await getInboundMailByImap({ mailbox: params.mailbox, uidValidity: params.uidValidity, uid: params.uid });
		const existingByMessageId = params.messageId ? await getInboundMailByMessageId(params.messageId) : undefined;
		const existing = existingByUid ?? existingByMessageId;
		if (!existing) throw new Error("Inbound abuse mail uniqueness conflict could not be reconciled.");
		await ensureInboundReplyClassification(existing.id);
		return { id: existing.id, created: false };
	}
}

export async function getMailMessage(messageId: bigint) {
	const db = await getDb();
	return db.select().from(abuseMailMessages).where(eq(abuseMailMessages.id, messageId)).get();
}

export async function getInboundMailByImap(params: { mailbox: string; uidValidity: number; uid: number }) {
	const db = await getDb();
	return db
		.select()
		.from(abuseMailMessages)
		.where(
			and(
				eq(abuseMailMessages.direction, "inbound"),
				eq(abuseMailMessages.imapMailbox, params.mailbox),
				eq(abuseMailMessages.imapUidValidity, params.uidValidity),
				eq(abuseMailMessages.imapUid, params.uid),
			),
		)
		.get();
}

export async function getInboundMailByMessageId(messageId: string) {
	const db = await getDb();
	return db
		.select()
		.from(abuseMailMessages)
		.where(and(eq(abuseMailMessages.direction, "inbound"), eq(abuseMailMessages.messageId, messageId)))
		.limit(1)
		.get();
}

export async function setMailClassification(messageId: bigint, classification: AbuseMailClassification, extractedLinks: string[], disposition?: string): Promise<void> {
	const db = await getDb();
	await db
		.update(abuseMailMessages)
		.set({ classification, extractedLinks, disposition, processingAttempts: sql`${abuseMailMessages.processingAttempts} + 1`, updatedAt: now() })
		.where(eq(abuseMailMessages.id, messageId));
}
