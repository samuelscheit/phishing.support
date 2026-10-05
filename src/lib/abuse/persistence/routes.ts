import { and, eq } from "drizzle-orm";

import { getDb } from "../../db";
import { generateId } from "../../db/ids";
import { abuseProviderRoutes, abuseProviderRuns, abuseTargets, type AbuseProviderRoute, type AbuseRouteStatus } from "../schema";
import type { ResolvedRouteInput } from "../route_contracts";
import { now, recordEvent } from "./shared";
import { recomputeReportStatusInTransaction } from "./report_status";
import { IMMUTABLE_ROUTE_STATUSES } from "./state";

export type { ResolvedRouteInput } from "../route_contracts";

export async function setTargetResolution(params: {
	targetId: bigint;
	status: "resolved" | "no_route" | "failed";
	resolverSnapshot?: Record<string, unknown>;
	disposition?: string;
}): Promise<void> {
	const db = await getDb();
	db.transaction(
		(tx) => {
			const target = tx.select().from(abuseTargets).where(eq(abuseTargets.id, params.targetId)).get();
			if (!target) return;
			tx.update(abuseTargets)
				.set({
					resolutionStatus: params.status,
					resolverSnapshot: params.resolverSnapshot,
					disposition: params.disposition,
					updatedAt: now(),
				})
				.where(eq(abuseTargets.id, params.targetId))
				.run();
			recordEvent(tx, {
				reportId: target.reportId,
				targetId: target.id,
				eventType: "target.resolved",
				data: { status: params.status, disposition: params.disposition },
			});
		},
		{ behavior: "immediate" }
	);
}

export async function upsertResolvedRoute(targetId: bigint, input: ResolvedRouteInput): Promise<AbuseProviderRoute> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const target = tx.select().from(abuseTargets).where(eq(abuseTargets.id, targetId)).get();
			if (!target) throw new Error(`Abuse target ${targetId.toString()} does not exist.`);
			const existing = tx
				.select()
				.from(abuseProviderRoutes)
				.where(and(eq(abuseProviderRoutes.targetId, targetId), eq(abuseProviderRoutes.routeKey, input.routeKey)))
				.get();
			const timestamp = now();
			if (existing) {
					// `providerDefinitionVersion` and `providerDefinitionHash` are route
					// pins. Never refresh them, or any other resolver-owned route field,
					// after a route has left initial resolution. Otherwise a stale retry
					// could silently bless a task created under a different definition.
					if (existing.status !== "resolving") return existing;
					tx.update(abuseProviderRoutes)
						.set({
						providerRegistryKey: input.providerRegistryKey,
						providerDisplayName: input.providerDisplayName,
						routeType: input.routeType,
						verifiedEmail: input.verifiedEmail,
						providerDefinitionVersion: input.providerDefinitionVersion,
						providerDefinitionHash: input.providerDefinitionHash,
						resolverProvenance: input.resolverProvenance,
						resolutionSnapshot: input.resolutionSnapshot,
						verificationResult: input.verificationResult,
						serviceIdentity: input.serviceIdentity,
							status: input.status ?? existing.status,
						updatedAt: timestamp,
					})
					.where(eq(abuseProviderRoutes.id, existing.id))
					.run();
				return tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, existing.id)).get()!;
			}
			const id = generateId();
			tx.insert(abuseProviderRoutes)
				.values({
					id,
					reportId: target.reportId,
					targetId,
					routeKey: input.routeKey,
					providerRegistryKey: input.providerRegistryKey,
					providerDisplayName: input.providerDisplayName,
					routeType: input.routeType,
					verifiedEmail: input.verifiedEmail,
					providerDefinitionVersion: input.providerDefinitionVersion,
					providerDefinitionHash: input.providerDefinitionHash,
					resolverProvenance: input.resolverProvenance,
					resolutionSnapshot: input.resolutionSnapshot,
					verificationResult: input.verificationResult,
					serviceIdentity: input.serviceIdentity,
					status: input.status ?? "resolving",
					createdAt: timestamp,
					updatedAt: timestamp,
				})
				.run();
			recordEvent(tx, {
				reportId: target.reportId,
				targetId,
				routeId: id,
				eventType: "route.resolved",
				data: { providerRegistryKey: input.providerRegistryKey, routeType: input.routeType, status: input.status ?? "resolving" },
			});
			return tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, id)).get()!;
		},
		{ behavior: "immediate" }
	);
}

/**
 * Compare-and-set route lifecycle state. Worker jobs use this for every
 * externally meaningful transition.  The aggregate is recalculated in the
 * same SQLite transaction, so a stale worker cannot write an aggregate that
 * was calculated from an earlier route snapshot.
 */

export async function transitionRouteStatus(params: {
	routeId: bigint;
	from: AbuseRouteStatus | AbuseRouteStatus[];
	to: AbuseRouteStatus;
	data?: Record<string, unknown>;
}): Promise<boolean> {
	const db = await getDb();
	const expected = new Set(Array.isArray(params.from) ? params.from : [params.from]);
	return db.transaction(
		(tx) => {
			const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, params.routeId)).get();
			if (!route || !expected.has(route.status)) return false;
			if (route.status !== params.to && IMMUTABLE_ROUTE_STATUSES.has(route.status)) return false;
			if (route.status !== params.to) {
				const updated = tx
					.update(abuseProviderRoutes)
					.set({ status: params.to, updatedAt: now() })
					.where(and(eq(abuseProviderRoutes.id, route.id), eq(abuseProviderRoutes.status, route.status)))
					.returning({ id: abuseProviderRoutes.id })
					.get();
				if (!updated) return false;
				recordEvent(tx, {
					reportId: route.reportId,
					targetId: route.targetId,
					routeId: route.id,
					eventType: "route.status_changed",
					data: { from: route.status, to: params.to, ...(params.data ?? {}) },
				});
				recomputeReportStatusInTransaction(tx, route.reportId, {
					reason: "route_status_transition",
					routeId: route.id.toString(),
				});
			}
			return true;
		},
		{ behavior: "immediate" },
	);
}

/** Atomic route update for callers that do not need to name a predecessor. */

export async function setRouteStatus(
	routeId: bigint,
	status: AbuseRouteStatus,
	data: Record<string, unknown> = {},
	expectedFrom?: AbuseRouteStatus | AbuseRouteStatus[],
): Promise<boolean> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, routeId)).get();
			if (!route || route.status === status || IMMUTABLE_ROUTE_STATUSES.has(route.status)) return false;
			if (expectedFrom !== undefined) {
				const expected = new Set(Array.isArray(expectedFrom) ? expectedFrom : [expectedFrom]);
				if (!expected.has(route.status)) return false;
			}
			const updated = tx
				.update(abuseProviderRoutes)
				.set({ status, updatedAt: now() })
				.where(and(eq(abuseProviderRoutes.id, routeId), eq(abuseProviderRoutes.status, route.status)))
				.returning({ id: abuseProviderRoutes.id })
				.get();
			if (!updated) return false;
			recordEvent(tx, {
				reportId: route.reportId,
				targetId: route.targetId,
				routeId,
				eventType: "route.status_changed",
				data: { from: route.status, to: status, ...data },
			});
			recomputeReportStatusInTransaction(tx, route.reportId, { reason: "route_status_set", routeId: route.id.toString() });
			return true;
		},
		{ behavior: "immediate" },
	);
}

/**
 * Atomically record an ambiguous external side effect.  The run, route,
 * lifecycle events, and public aggregate are one durable transition; a
 * caller must not update only one of those records and then throw.
 */

export async function markUnknownExternalState(params: {
	routeId: bigint;
	runId?: bigint;
	error: string;
	reason?: string;
}): Promise<void> {
	const db = await getDb();
	db.transaction(
		(tx) => {
			const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, params.routeId)).get();
			if (!route) return;
			// A stale external-call error must never downgrade a route that was
			// already safely settled by a webhook/reconciliation job. A known
			// delivery failure is also stronger than a late, ambiguous transport
			// error: an explicit SMTP rejection or correlated bounce is safe to
			// retry, whereas turning it into unknown_external_state would lose
			// that retry path.
			// An explicit SMTP rejection normally leaves the route reusable. The
			// one exception is a missing or altered immutable outbound draft: a
			// retry could no longer prove it is resending the same provider-facing
			// allegation, so stop it for operator review instead of regenerating
			// prose and silently changing the message.
			if (IMMUTABLE_ROUTE_STATUSES.has(route.status) || (route.status === "delivery_failed" && params.reason !== "email_draft_integrity_failure")) return;
			const timestamp = now();
			const error = params.error.slice(0, 2_000);
			if (params.runId !== undefined) {
				const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, params.runId)).get();
				if (run) {
					tx.update(abuseProviderRuns)
						.set({ executionStatus: "unknown_external_state", failureReason: error, updatedAt: timestamp })
						.where(eq(abuseProviderRuns.id, run.id))
						.run();
					recordEvent(tx, {
						reportId: run.reportId,
						routeId: run.routeId,
						runId: run.id,
						eventType: "provider_run.unknown_external_state",
						data: { error, reason: params.reason },
					});
				}
			}
			if (route.status !== "unknown_external_state") {
				tx.update(abuseProviderRoutes)
					.set({ status: "unknown_external_state", updatedAt: timestamp })
					.where(eq(abuseProviderRoutes.id, route.id))
					.run();
			}
			recordEvent(tx, {
				reportId: route.reportId,
				targetId: route.targetId,
				routeId: route.id,
				runId: params.runId,
				eventType: "route.unknown_external_state",
				data: { from: route.status, error, reason: params.reason, operatorResolutionRequired: true },
			});

			recomputeReportStatusInTransaction(tx, route.reportId, {
				reason: "unknown_external_state",
				routeId: route.id.toString(),
			});
		},
		{ behavior: "immediate" },
	);
}

export async function setRouteVerification(
	routeId: bigint,
	verificationResult: Record<string, unknown>,
	serviceIdentity?: Record<string, unknown>,
	expectedStatus: AbuseRouteStatus = "resolving",
): Promise<boolean> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const route = tx.select({ status: abuseProviderRoutes.status }).from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, routeId)).get();
			if (!route || route.status !== expectedStatus) return false;
			tx.update(abuseProviderRoutes)
				.set({ verificationResult, serviceIdentity, updatedAt: now() })
				.where(and(eq(abuseProviderRoutes.id, routeId), eq(abuseProviderRoutes.status, expectedStatus)))
				.run();
			return true;
		},
		{ behavior: "immediate" },
	);
}
