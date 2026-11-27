import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db";
import { generateId } from "../../db/ids";
import {
	abuseEvents,
	jobs,
	abuseMailMessages,
	abuseProviderRoutes,
	abuseProviderRuns,
	type AbuseProviderRoute,
	type AbuseProviderRun,
	type AbuseRouteStatus,
	type AbuseRunStatus,
} from "../schema";
import { activeJobByDedupeKey, insertQueuedJob } from "./jobs";
import { recomputeReportStatusInTransaction } from "./report_status";
import { claimRoute, insertProviderRun, now, recordEvent } from "./shared";
import { hashStableJson } from "../../util/hash";

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
			if (!claimRoute(tx, route, { expected: priorStatus, reason: "email_delivery_started", timestamp })) return undefined;
			let run: AbuseProviderRun;
			let created = false;
			if (existing) {
				// `delivery_failed` is reached only after an explicit SMTP rejection
				// or a correlated bounce. It is the one safe retry path: retain the
				// exact correlation/reply identity while making this local attempt
				// visibly active again before another MIME message is persisted.
				tx.update(abuseProviderRuns)
					.set({ providerPayload: params.providerPayload, payloadHash: hashStableJson(params.providerPayload), executionStatus: "starting", failureReason: null, updatedAt: timestamp })
					.where(eq(abuseProviderRuns.id, existing.id))
					.run();
				// The payload is the stored one for a plain retry, a new draft for the resend after our relay refused it.
				run = { ...existing, providerPayload: params.providerPayload, payloadHash: hashStableJson(params.providerPayload), executionStatus: "starting", failureReason: null, updatedAt: timestamp };
			} else {
				run = insertProviderRun(tx, route, { providerPayload: params.providerPayload, correlationKey: params.correlationKey, executionStatus: "starting", timestamp });
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
 * Settle a known SMTP outcome and its route in one compare-and-set
 * transaction. This prevents a late bounce, a duplicate classifier, or a
 * lease-replayed sender from overwriting a newer email lifecycle state.
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
	/** Resend only after a temporary failure; a permanent rejection would bounce again. */
	retry: boolean;
	/** Why the route failed: a provider's bounce unless our relay refused the report. */
	reason?: "provider_bounce" | "relay_refused" | "delivery_retries_exhausted";
}): Promise<{ settled: boolean; routeId?: bigint; runId?: bigint; outboundMessageId?: bigint; stale?: true }> {
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
			// From here the notice names exactly one send of this route: when that
			// send is already settled, the notice is stale and must change nothing.
			const stale = { settled: false, stale: true } as const;
			const outbound = matches[0]!;
			if (!outbound.runId) return stale;
			const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, outbound.runId)).get();
			if (!run || run.routeId !== inbound.routeId || !["starting", "delivered"].includes(run.executionStatus)) return stale;
			const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, run.routeId)).get();
			if (!route || !["running", "awaiting_provider_reply"].includes(route.status)) return stale;

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
			if (!outboundUpdated) return stale;
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
				data: { from: route.status, to: "delivery_failed", reason: params.reason ?? "provider_bounce", inboundMessageId: inbound.id.toString() },
			});

			const dedupeKey = `email-retry:${route.id.toString()}:${inbound.id.toString()}`;
			if (params.retry && !activeJobByDedupeKey(tx, dedupeKey)) {
				insertQueuedJob(tx, {
					jobType: "send_email",
					reportId: route.reportId,
					routeId: route.id,
					payload: { retryReason: "provider_bounce", bouncedOutboundMessageId: outbound.id.toString(), inboundMessageId: inbound.id.toString() },
					dedupeKey,
					nextAttemptAt: new Date(timestamp.getTime() + (params.retryAfterMs ?? 60_000)),
				}, { reason: "provider_bounce", inboundMessageId: inbound.id.toString(), bouncedRunId: run.id.toString() });
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

/**
 * Mail routes that wait in `delivery_failed` with no send queued because our
 * relay refused their last attempt (mail/relay_refusal.ts), not because a
 * provider bounced it.
 */
export async function listRelayRefusedRoutes(): Promise<AbuseProviderRoute[]> {
	const db = await getDb();
	const routes = db.select().from(abuseProviderRoutes)
		.where(and(eq(abuseProviderRoutes.routeType, "email"), eq(abuseProviderRoutes.status, "delivery_failed")))
		.all();
	if (!routes.length) return [];
	const ids = routes.map((route) => route.id);
	const lastBounce = new Map(
		db.select({ routeId: abuseMailMessages.routeId, classification: abuseMailMessages.classification }).from(abuseMailMessages)
			.where(and(inArray(abuseMailMessages.routeId, ids), inArray(abuseMailMessages.classification, ["relay_refused", "bounce"])))
			.orderBy(abuseMailMessages.createdAt, abuseMailMessages.id)
			.all()
			.map((message) => [message.routeId, message.classification]),
	);
	const pending = new Set(
		db.select({ routeId: jobs.routeId }).from(jobs)
			.where(and(inArray(jobs.routeId, ids), eq(jobs.jobType, "send_email"), inArray(jobs.status, ["queued", "running", "unknown_external_state"])))
			.all()
			.map((job) => job.routeId),
	);
	return routes.filter((route) => lastBounce.get(route.id) === "relay_refused" && !pending.has(route.id));
}

/**
 * Mail routes in `status` whose last status change put them there for one of
 * `reasons` (the event's `reason`), e.g. `provider_rejected` for
 * `uncorrelated_provider_bounce`.
 */
export async function listEmailRoutesByLastStatusChange(status: AbuseRouteStatus, reasons: readonly string[]): Promise<AbuseProviderRoute[]> {
	const db = await getDb();
	const routes = db.select().from(abuseProviderRoutes)
		.where(and(eq(abuseProviderRoutes.routeType, "email"), eq(abuseProviderRoutes.status, status)))
		.all();
	if (!routes.length) return [];
	const lastChange = new Map(
		db.select({ routeId: abuseEvents.routeId, data: abuseEvents.data }).from(abuseEvents)
			.where(and(inArray(abuseEvents.routeId, routes.map((route) => route.id)), eq(abuseEvents.eventType, "route.status_changed")))
			.orderBy(asc(abuseEvents.createdAt), asc(abuseEvents.id))
			.all()
			.map((event) => [event.routeId, event.data]),
	);
	return routes.filter((route) => {
		const change = lastChange.get(route.id);
		return change?.to === status && typeof change.reason === "string" && reasons.includes(change.reason);
	});
}

/**
 * Store delivery reports that were taken for replies as the bounces they are
 * (`references`: the sends each returned) and reopen their route, which a
 * misread report ended as `provider_rejected`, so the bounce can be settled
 * like any other. False when the route is no longer in that state.
 */
export async function reopenRouteForMisreadBounces(params: { routeId: bigint; bounces: Array<{ messageId: bigint; references: string[] }> }): Promise<boolean> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const timestamp = now();
			const route = tx.update(abuseProviderRoutes)
				.set({ status: "awaiting_provider_reply", updatedAt: timestamp })
				.where(and(eq(abuseProviderRoutes.id, params.routeId), eq(abuseProviderRoutes.status, "provider_rejected")))
				.returning()
				.get();
			if (!route) return false;
			for (const bounce of params.bounces) {
				tx.update(abuseMailMessages)
					.set({ kind: "bounce", references: bounce.references, classification: "bounce", disposition: "delivery_status_notification", updatedAt: timestamp })
					.where(and(eq(abuseMailMessages.id, bounce.messageId), eq(abuseMailMessages.routeId, route.id), eq(abuseMailMessages.direction, "inbound")))
					.run();
			}
			recordEvent(tx, {
				reportId: route.reportId,
				targetId: route.targetId,
				routeId: route.id,
				eventType: "route.status_changed",
				data: { from: "provider_rejected", to: "awaiting_provider_reply", reason: "misread_bounce_reopened", inboundMessageIds: params.bounces.map((bounce) => bounce.messageId.toString()) },
			});
			recomputeReportStatusInTransaction(tx, route.reportId, { reason: "misread_bounce_reopened", routeId: route.id.toString() });
			return true;
		},
		{ behavior: "immediate" },
	);
}
