import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "../../db";
import { generateId } from "../../db/ids";
import {
	abuseMailCodes,
	abuseMailMessages,
	abuseProviderRoutes,
	abuseProviderRuns,
	type AbuseMailClassification,
	type AbuseProviderRoute,
} from "../schema";
import { sha256Hex } from "../security";
import { recomputeReportStatusInTransaction } from "./report_status";
import { insertArtifact, now, recordEvent } from "./shared";

class DuplicateInboundMailError extends Error {
	readonly code = "duplicate_inbound_abuse_mail";
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

export async function findInboundRoute(params: { recipients: string[]; inReplyTo?: string; references?: string[] }) {
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
	if (candidateRouteIds.size !== 1) return undefined;
	const routeId = [...candidateRouteIds][0];
	return db.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, routeId)).get();
}

export async function getWaitingCodeRoute(): Promise<AbuseProviderRoute | undefined> {
	const db = await getDb();
	const routes = await db
		.select()
		.from(abuseProviderRoutes)
		.where(and(eq(abuseProviderRoutes.providerRegistryKey, "gname"), eq(abuseProviderRoutes.status, "waiting_code")))
		.orderBy(asc(abuseProviderRoutes.updatedAt))
		.limit(2);
	return routes.length === 1 ? routes[0] : undefined;
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
			const existing = tx
				.select({ id: abuseMailMessages.id })
				.from(abuseMailMessages)
				.where(
					and(
						eq(abuseMailMessages.imapMailbox, params.mailbox),
						eq(abuseMailMessages.imapUidValidity, params.uidValidity),
						eq(abuseMailMessages.imapUid, params.uid),
					),
				)
				.get();
			if (existing) return { id: existing.id, created: false };
			if (params.messageId) {
				const existingMessage = tx
					.select({ id: abuseMailMessages.id })
					.from(abuseMailMessages)
					.where(and(eq(abuseMailMessages.direction, "inbound"), eq(abuseMailMessages.messageId, params.messageId)))
					.get();
				if (existingMessage) return { id: existingMessage.id, created: false };
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

export async function createMailCode(params: { reportId: bigint; routeId: bigint; runId?: bigint; mailMessageId: bigint; code: string; correlationKey?: string }): Promise<bigint> {
	const db = await getDb();
	const id = generateId();
	await db.insert(abuseMailCodes).values({
		id,
		reportId: params.reportId,
		routeId: params.routeId,
		runId: params.runId,
		mailMessageId: params.mailMessageId,
		codeHash: sha256Hex(params.code),
		correlationKey: params.correlationKey,
		status: "received",
		createdAt: now(),
	});
	return id;
}

/**
 * Set the durable pre-side-effect marker for a shared-mailbox verification
 * code. On recovery a run left in `sending_code` is ambiguous and must be
 * resolved rather than automatically delivered again.
 */

export async function prepareTotpDelivery(params: {
	routeId: bigint;
	runId: bigint;
	mailMessageId: bigint;
	code: string;
	correlationKey?: string;
}): Promise<{ state: "prepared"; mailCodeId: bigint } | { state: "already_started" }> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, params.runId)).get();
			const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, params.routeId)).get();
			if (!run || !route || run.routeId !== route.id) throw new Error("Provider run is not owned by the GNAME route.");
			if (route.status !== "waiting_code") throw new Error("Provider route is no longer waiting for a verification code.");
			if (run.executionStatus === "sending_code") return { state: "already_started" as const };
			if (!run.skyvernRunId || !["waiting_code", "running"].includes(run.executionStatus)) {
				throw new Error("Provider run is not eligible for verification-code delivery.");
			}
			const timestamp = now();
			const mailCodeId = generateId();
			tx.insert(abuseMailCodes)
				.values({
					id: mailCodeId,
					reportId: route.reportId,
					routeId: route.id,
					runId: run.id,
					mailMessageId: params.mailMessageId,
					codeHash: sha256Hex(params.code),
					correlationKey: params.correlationKey,
					status: "delivery_started",
					createdAt: timestamp,
				})
				.run();
			tx.update(abuseProviderRuns)
				.set({ executionStatus: "sending_code", updatedAt: timestamp })
				.where(eq(abuseProviderRuns.id, run.id))
				.run();
			recordEvent(tx, {
				reportId: route.reportId,
				routeId: route.id,
				runId: run.id,
				eventType: "provider_run.totp_delivery_started",
				data: { mailMessageId: params.mailMessageId.toString() },
			});
			return { state: "prepared" as const, mailCodeId };
		},
		{ behavior: "immediate" },
	);
}

/**
 * Completes a code-delivery attempt only if the same run is still in the
 * durable pre-side-effect state. A late SDK success after reconciliation has
 * settled the route is ignored rather than reopening or overwriting it.
 */

export async function settleTotpDelivery(params: { routeId: bigint; runId: bigint; mailCodeId: bigint }): Promise<boolean> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, params.runId)).get();
			const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, params.routeId)).get();
			if (!run || !route || run.routeId !== route.id || run.executionStatus !== "sending_code" || route.status !== "waiting_code") return false;
			const code = tx.select().from(abuseMailCodes).where(eq(abuseMailCodes.id, params.mailCodeId)).get();
			if (!code || code.runId !== run.id || code.status !== "delivery_started") return false;
			const timestamp = now();
			const runUpdated = tx
				.update(abuseProviderRuns)
				.set({ executionStatus: "running", updatedAt: timestamp })
				.where(and(eq(abuseProviderRuns.id, run.id), eq(abuseProviderRuns.executionStatus, "sending_code")))
				.returning({ id: abuseProviderRuns.id })
				.get();
			if (!runUpdated) return false;
			const routeUpdated = tx
				.update(abuseProviderRoutes)
				.set({ status: "running", updatedAt: timestamp })
				.where(and(eq(abuseProviderRoutes.id, route.id), eq(abuseProviderRoutes.status, "waiting_code")))
				.returning({ id: abuseProviderRoutes.id })
				.get();
			if (!routeUpdated) throw new Error("Verification code was delivered after the route left waiting_code.");
			tx.update(abuseMailCodes)
				.set({ status: "used", usedAt: timestamp })
				.where(and(eq(abuseMailCodes.id, code.id), eq(abuseMailCodes.status, "delivery_started")))
				.run();
			recordEvent(tx, {
				reportId: route.reportId,
				routeId: route.id,
				runId: run.id,
				eventType: "provider_run.totp_delivery_completed",
				data: { mailCodeId: code.id.toString() },
			});
			recordEvent(tx, {
				reportId: route.reportId,
				targetId: route.targetId,
				routeId: route.id,
				runId: run.id,
				eventType: "route.status_changed",
				data: { from: "waiting_code", to: "running", reason: "totp_delivery_completed" },
			});
			recomputeReportStatusInTransaction(tx, route.reportId, { reason: "totp_delivery_completed", routeId: route.id.toString() });
			return true;
		},
		{ behavior: "immediate" },
	);
}

export async function markMailCodeUsed(codeId: bigint): Promise<void> {
	const db = await getDb();
	await db.update(abuseMailCodes).set({ status: "used", usedAt: now() }).where(eq(abuseMailCodes.id, codeId));
}
