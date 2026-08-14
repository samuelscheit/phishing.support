import { and, desc, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db";
import { generateId } from "../../db/ids";
import {
	abuseJobs,
	abuseMailMessages,
	abuseProviderRoutes,
	abuseProviderRuns,
	type AbuseProviderRun,
	type AbuseRouteStatus,
	type AbuseRunStatus,
} from "../schema";
import { hashStableJson } from "../security";
import { recomputeReportStatusInTransaction } from "./report_status";
import { now, recordEvent } from "./shared";

export async function beginEmailDelivery(params: {
	routeId: bigint;
	providerPayload: Record<string, unknown>;
	correlationKey: string;
}): Promise<{ run: AbuseProviderRun; created: boolean; previousDeliveryFailed: boolean } | undefined> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, params.routeId)).get();
			if (!route || !["verified", "delivery_failed"].includes(route.status)) return undefined;
			const priorStatus = route.status;
			const existing = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.correlationKey, params.correlationKey)).get();
			// A route newly verified for SMTP must not inherit an unrelated old
			// attempt. Only the explicit delivery_failed retry path may reuse its
			// durable reply identity and correlation key.
			if (existing && priorStatus !== "delivery_failed") return undefined;
			const timestamp = now();
			const updated = tx
				.update(abuseProviderRoutes)
				.set({ status: "running", updatedAt: timestamp })
				.where(and(eq(abuseProviderRoutes.id, route.id), eq(abuseProviderRoutes.status, priorStatus)))
				.returning({ id: abuseProviderRoutes.id })
				.get();
			if (!updated) return undefined;
			recordEvent(tx, {
				reportId: route.reportId,
				targetId: route.targetId,
				routeId: route.id,
				eventType: "route.status_changed",
				data: { from: priorStatus, to: "running", reason: "email_delivery_started" },
			});
			let run: AbuseProviderRun;
			let created = false;
			if (existing) {
				// `delivery_failed` is reached only after an explicit SMTP rejection
				// or a correlated bounce. It is the one safe retry path: retain the
				// exact correlation/reply identity while making this local attempt
				// visibly active again before another MIME message is persisted.
				tx.update(abuseProviderRuns)
					.set({ executionStatus: "starting", failureReason: null, updatedAt: timestamp })
					.where(eq(abuseProviderRuns.id, existing.id))
					.run();
				run = { ...existing, executionStatus: "starting", failureReason: null, updatedAt: timestamp };
			} else {
				const id = generateId();
				tx.insert(abuseProviderRuns)
					.values({
						id,
						reportId: route.reportId,
						routeId: route.id,
						providerPayload: params.providerPayload,
						payloadHash: hashStableJson(params.providerPayload),
						correlationKey: params.correlationKey,
						attemptCount: 0,
						executionStatus: "starting",
						createdAt: timestamp,
						updatedAt: timestamp,
					})
					.run();
				recordEvent(tx, {
					reportId: route.reportId,
					targetId: route.targetId,
					routeId: route.id,
					runId: id,
					eventType: "provider_run.created",
					data: { payloadHash: hashStableJson(params.providerPayload), correlationKey: params.correlationKey },
				});
				run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, id)).get()!;
				created = true;
			}
			recomputeReportStatusInTransaction(tx, route.reportId, {
				reason: "email_delivery_started",
				routeId: route.id.toString(),
			});
			return { run, created, previousDeliveryFailed: priorStatus === "delivery_failed" };
		},
		{ behavior: "immediate" },
	);
}

/**
 * Persist a durable marker immediately before calling Skyvern's task-create
 * endpoint. The immutable payload must have been saved already. A restart
 * after this marker but before a task ID is known is intentionally ambiguous
 * and must fail closed rather than create a duplicate provider complaint.
 */

export async function settleEmailDelivery(params: {
	runId: bigint;
	expectedRunStatus: "starting" | "delivered";
	expectedRouteStatus: "running" | "awaiting_provider_reply";
	outcome: "sent" | "failed";
	failureReason?: string;
}): Promise<boolean> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, params.runId)).get();
			if (!run || run.executionStatus !== params.expectedRunStatus) return false;
			const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, run.routeId)).get();
			if (!route || route.status !== params.expectedRouteStatus) return false;
			const timestamp = now();
			const nextRunStatus: AbuseRunStatus = params.outcome === "sent" ? "delivered" : "failed";
			const nextRouteStatus: AbuseRouteStatus = params.outcome === "sent" ? "awaiting_provider_reply" : "delivery_failed";
			const runUpdated = tx
				.update(abuseProviderRuns)
				.set({ executionStatus: nextRunStatus, failureReason: params.failureReason, attemptCount: run.attemptCount + 1, updatedAt: timestamp })
				.where(and(eq(abuseProviderRuns.id, run.id), eq(abuseProviderRuns.executionStatus, params.expectedRunStatus)))
				.returning({ id: abuseProviderRuns.id })
				.get();
			if (!runUpdated) return false;
			const routeUpdated = tx
				.update(abuseProviderRoutes)
				.set({ status: nextRouteStatus, updatedAt: timestamp })
				.where(and(eq(abuseProviderRoutes.id, route.id), eq(abuseProviderRoutes.status, params.expectedRouteStatus)))
				.returning({ id: abuseProviderRoutes.id })
				.get();
			if (!routeUpdated) throw new Error("Email delivery settled after the route left its expected state.");
			recordEvent(tx, {
				reportId: run.reportId,
				routeId: route.id,
				runId: run.id,
				eventType: "provider_run.email_settled",
				data: { from: run.executionStatus, to: nextRunStatus, failureReason: params.failureReason },
			});
			recordEvent(tx, {
				reportId: route.reportId,
				targetId: route.targetId,
				routeId: route.id,
				runId: run.id,
				eventType: "route.status_changed",
				data: { from: route.status, to: nextRouteStatus, reason: "email_delivery_settled", failureReason: params.failureReason },
			});
			recomputeReportStatusInTransaction(tx, route.reportId, {
				reason: "email_delivery_settled",
				routeId: route.id.toString(),
			});
			return true;
		},
		{ behavior: "immediate" },
	);
}

/**
 * An error while building MIME, storing a local artifact/message, or
 * recording an explicit SMTP rejection is known to have occurred before a
 * provider accepted the message.  Recover that narrow, safe class of error
 * atomically: a claimed route must never remain `running` with a `starting`
 * run after a local failure, and any pending local message is deliberately
 * marked failed before a retry reuses the route's correlation identity.
 */

export async function recoverEmailPreparationFailure(params: {
	runId: bigint;
	error: string;
}): Promise<boolean> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, params.runId)).get();
			if (!run || run.executionStatus !== "starting") return false;
			const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, run.routeId)).get();
			if (!route || route.status !== "running") return false;
			const timestamp = now();
			const error = params.error.slice(0, 2_000);

			// A pending outbound record is local proof that SMTP was not yet
			// invoked by this code path. Marking it failed keeps the next attempt
			// unambiguously safe and preserves the same reply identity if one was
			// already generated.
			tx.update(abuseMailMessages)
				.set({ status: "failed", error, occurredAt: timestamp, updatedAt: timestamp })
				.where(
					and(
						eq(abuseMailMessages.runId, run.id),
						eq(abuseMailMessages.direction, "outbound"),
						eq(abuseMailMessages.status, "pending"),
					),
				)
				.run();

			const runUpdated = tx
				.update(abuseProviderRuns)
				.set({ executionStatus: "failed", failureReason: error, updatedAt: timestamp })
				.where(and(eq(abuseProviderRuns.id, run.id), eq(abuseProviderRuns.executionStatus, "starting")))
				.returning({ id: abuseProviderRuns.id })
				.get();
			if (!runUpdated) return false;
			const routeUpdated = tx
				.update(abuseProviderRoutes)
				.set({ status: "delivery_failed", updatedAt: timestamp })
				.where(and(eq(abuseProviderRoutes.id, route.id), eq(abuseProviderRoutes.status, "running")))
				.returning({ id: abuseProviderRoutes.id })
				.get();
			if (!routeUpdated) throw new Error("Safe email preparation failure settled after the route left running.");
			recordEvent(tx, {
				reportId: run.reportId,
				routeId: route.id,
				runId: run.id,
				eventType: "provider_run.email_preparation_failed",
				data: { error },
			});
			recordEvent(tx, {
				reportId: route.reportId,
				targetId: route.targetId,
				routeId: route.id,
				runId: run.id,
				eventType: "route.status_changed",
				data: { from: "running", to: "delivery_failed", reason: "email_preparation_failed", error },
			});
			recomputeReportStatusInTransaction(tx, route.reportId, {
				reason: "email_preparation_failed",
				routeId: route.id.toString(),
			});
			return true;
		},
		{ behavior: "immediate" },
	);
}

/**
 * Settle an inbound bounce against the exact persisted outbound RFC message.
 *
 * SMTP acceptance and route settlement intentionally happen in separate
 * operations because the canonical outbound MIME must be retained before the
 * network call. A fast bounce can therefore be ingested after outbound mail
 * is marked `sent` while the route is still `running` and the run remains
 * `starting`. This transaction accepts both that pre-settlement state and
 * the ordinary delivered/awaiting-provider-reply state, so the sender can
 * finish harmlessly without overwriting the evidence of a real bounce.
 */

export async function settleCorrelatedEmailBounce(params: {
	inboundMessageId: bigint;
	failureReason?: string;
	retryAfterMs?: number;
}): Promise<{ settled: boolean; routeId?: bigint; runId?: bigint; outboundMessageId?: bigint }> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const inbound = tx.select().from(abuseMailMessages).where(eq(abuseMailMessages.id, params.inboundMessageId)).get();
			if (!inbound || inbound.direction !== "inbound") return { settled: false };
			const identifiers = [...new Set([inbound.inReplyTo, ...inbound.references].filter((value): value is string => Boolean(value)))];
			if (identifiers.length === 0) return { settled: false };
			const matches = tx
				.select()
				.from(abuseMailMessages)
				.where(
					and(
						eq(abuseMailMessages.routeId, inbound.routeId),
						eq(abuseMailMessages.direction, "outbound"),
						inArray(abuseMailMessages.messageId, identifiers),
					),
				)
				.orderBy(desc(abuseMailMessages.createdAt))
				.limit(2)
				.all();
			if (matches.length !== 1) return { settled: false };
			const outbound = matches[0]!;
			if (!outbound.runId) return { settled: false };
			const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, outbound.runId)).get();
			if (!run || run.routeId !== inbound.routeId || !["starting", "delivered"].includes(run.executionStatus)) return { settled: false };
			const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, run.routeId)).get();
			if (!route || !["running", "awaiting_provider_reply"].includes(route.status)) return { settled: false };

			const timestamp = now();
			const error = (params.failureReason ?? "Provider bounce received.").slice(0, 2_000);
			const outboundUpdated = tx
				.update(abuseMailMessages)
				.set({ status: "failed", error, occurredAt: timestamp, updatedAt: timestamp })
				.where(
					and(
						eq(abuseMailMessages.id, outbound.id),
						inArray(abuseMailMessages.status, ["pending", "sent"]),
					),
				)
				.returning({ id: abuseMailMessages.id })
				.get();
			if (!outboundUpdated) return { settled: false };
			const runUpdated = tx
				.update(abuseProviderRuns)
				.set({ executionStatus: "failed", failureReason: error, updatedAt: timestamp })
				.where(and(eq(abuseProviderRuns.id, run.id), inArray(abuseProviderRuns.executionStatus, ["starting", "delivered"])))
				.returning({ id: abuseProviderRuns.id })
				.get();
			if (!runUpdated) throw new Error("Correlated bounce settled after the email run changed state.");
			const routeUpdated = tx
				.update(abuseProviderRoutes)
				.set({ status: "delivery_failed", updatedAt: timestamp })
				.where(and(eq(abuseProviderRoutes.id, route.id), inArray(abuseProviderRoutes.status, ["running", "awaiting_provider_reply"])))
				.returning({ id: abuseProviderRoutes.id })
				.get();
			if (!routeUpdated) throw new Error("Correlated bounce settled after the email route changed state.");
			recordEvent(tx, {
				reportId: run.reportId,
				routeId: route.id,
				runId: run.id,
				eventType: "provider_run.email_bounced",
				data: { inboundMessageId: inbound.id.toString(), outboundMessageId: outbound.id.toString(), error },
			});
			recordEvent(tx, {
				reportId: route.reportId,
				targetId: route.targetId,
				routeId: route.id,
				runId: run.id,
				eventType: "route.status_changed",
				data: { from: route.status, to: "delivery_failed", reason: "provider_bounce", inboundMessageId: inbound.id.toString() },
			});

			const dedupeKey = `email-retry:${route.id.toString()}:${inbound.id.toString()}`;
			const existingRetry = tx
				.select({ id: abuseJobs.id })
				.from(abuseJobs)
				.where(
					and(
						eq(abuseJobs.dedupeKey, dedupeKey),
						inArray(abuseJobs.status, ["queued", "running", "unknown_external_state"]),
					),
				)
				.get();
			if (!existingRetry) {
				const jobId = generateId();
				tx.insert(abuseJobs)
					.values({
						id: jobId,
						jobType: "send_email",
						reportId: route.reportId,
						routeId: route.id,
						payload: { retryReason: "provider_bounce", bouncedOutboundMessageId: outbound.id.toString(), inboundMessageId: inbound.id.toString() },
						dedupeKey,
						status: "queued",
						retryCount: 0,
						nextAttemptAt: new Date(timestamp.getTime() + (params.retryAfterMs ?? 60_000)),
						unknownExternalState: false,
						createdAt: timestamp,
						updatedAt: timestamp,
					})
					.run();
				recordEvent(tx, {
					reportId: route.reportId,
					routeId: route.id,
					runId: run.id,
					jobId,
					eventType: "job.queued",
					data: { jobType: "send_email", reason: "provider_bounce", inboundMessageId: inbound.id.toString() },
				});
			}
			recomputeReportStatusInTransaction(tx, route.reportId, {
				reason: "provider_bounce",
				routeId: route.id.toString(),
			});
			return { settled: true, routeId: route.id, runId: run.id, outboundMessageId: outbound.id };
		},
		{ behavior: "immediate" },
	);
}
