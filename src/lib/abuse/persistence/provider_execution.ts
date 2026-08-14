import { and, eq } from "drizzle-orm";

import { getDb } from "../../db";
import { generateId } from "../../db/ids";
import { abuseProviderRoutes, abuseProviderRuns, type AbuseProviderRun } from "../schema";
import { hashStableJson } from "../security";
import { recomputeReportStatusInTransaction } from "./report_status";
import { now, recordEvent } from "./shared";

export async function beginProviderExecution(params: {
	routeId: bigint;
	providerPayload: Record<string, unknown>;
	correlationKey: string;
	expectedStatus: "queued" | "verified" | "escalating_to_portal";
}): Promise<{ run: AbuseProviderRun; created: boolean; resumed: boolean } | undefined> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, params.routeId)).get();
			if (!route || ![params.expectedStatus, "running"].includes(route.status)) return undefined;
			const existing = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.correlationKey, params.correlationKey)).get();
			if (existing && (existing.routeId !== route.id || existing.reportId !== route.reportId)) {
				throw new Error("Provider correlation key belongs to a different route.");
			}
			if (route.status === "running") {
				if (!existing) return undefined;
				recordEvent(tx, {
					reportId: route.reportId,
					targetId: route.targetId,
					routeId: route.id,
					runId: existing.id,
					eventType: "provider_run.provider_execution_resumed",
					data: { correlationKey: params.correlationKey },
				});
				return { run: existing, created: false, resumed: true };
			}
			const timestamp = now();
			const updated = tx
				.update(abuseProviderRoutes)
				.set({ status: "running", updatedAt: timestamp })
				.where(and(eq(abuseProviderRoutes.id, route.id), eq(abuseProviderRoutes.status, params.expectedStatus)))
				.returning({ id: abuseProviderRoutes.id })
				.get();
			if (!updated) return undefined;
			recordEvent(tx, {
				reportId: route.reportId,
				targetId: route.targetId,
				routeId: route.id,
				eventType: "route.status_changed",
				data: { from: route.status, to: "running", reason: "provider_execution_started" },
			});
			let run: AbuseProviderRun;
			let created = false;
			if (existing) {
				run = existing;
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
				reason: "provider_execution_started",
				routeId: route.id.toString(),
			});
			return { run, created, resumed: false };
		},
		{ behavior: "immediate" },
	);
}
