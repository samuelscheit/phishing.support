import { and, eq } from "drizzle-orm";

import { getDb } from "../../../../db";
import { generateId } from "../../../../db/ids";
import { abuseMailCodes, abuseMailMessages, abuseProviderRoutes, abuseProviderRuns } from "../../../schema";
import { sha256Hex } from "../../../security";
import { recomputeReportStatusInTransaction } from "../../../persistence/report_status";
import { now, recordEvent } from "../../../persistence/shared";

/**
 * Persist the pre-side-effect marker for a GNAME verification code. A run
 * left in `sending_code` crossed an irreversible SDK boundary and can never
 * be replayed automatically.
 */
export async function prepareVerificationCodeDelivery(params: {
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
			if (!run || !route || route.providerRegistryKey !== "gname" || run.routeId !== route.id || run.reportId !== route.reportId) {
				throw new Error("Provider run is not owned by this GNAME route.");
			}
			const mail = tx.select().from(abuseMailMessages).where(eq(abuseMailMessages.id, params.mailMessageId)).get();
			if (!mail || mail.direction !== "inbound" || mail.routeId !== route.id || mail.reportId !== route.reportId) {
				throw new Error("Verification-code message is not an inbound message for this GNAME route.");
			}
			if (route.status !== "waiting_code") throw new Error("Provider route is no longer waiting for a verification code.");
			if (run.executionStatus === "sending_code") return { state: "already_started" };
			if (!run.skyvernRunId || run.executionStatus !== "waiting_code") {
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
			return { state: "prepared", mailCodeId };
		},
		{ behavior: "immediate" },
	);
}

/**
 * Complete one code delivery only while the same run remains in the durable
 * pre-call state. A late SDK success must not reopen a route reconciliation
 * has already settled.
 */
export async function settleVerificationCodeDelivery(params: { routeId: bigint; runId: bigint; mailCodeId: bigint }): Promise<boolean> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, params.runId)).get();
			const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, params.routeId)).get();
			if (!run || !route || route.providerRegistryKey !== "gname" || run.routeId !== route.id || run.executionStatus !== "sending_code" || route.status !== "waiting_code") {
				return false;
			}
			const code = tx.select().from(abuseMailCodes).where(eq(abuseMailCodes.id, params.mailCodeId)).get();
			if (!code || code.runId !== run.id || code.routeId !== route.id || code.reportId !== route.reportId || !code.mailMessageId || code.status !== "delivery_started") return false;
			const mail = tx.select().from(abuseMailMessages).where(eq(abuseMailMessages.id, code.mailMessageId)).get();
			if (!mail || mail.direction !== "inbound" || mail.routeId !== route.id || mail.reportId !== route.reportId) return false;
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
