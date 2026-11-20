import { eq } from "drizzle-orm";

import { getDb } from "../../db";
import { abuseProviderRoutes, abuseProviderRuns, type AbuseProviderRun } from "../schema";
import { recomputeReportStatusInTransaction } from "./report_status";
import { claimRoute, insertProviderRun, now, recordEvent } from "./shared";

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
			if (!claimRoute(tx, route, { expected: params.expectedStatus, reason: "provider_execution_started", timestamp })) return undefined;
			const created = !existing;
			const run = existing ?? insertProviderRun(tx, route, { providerPayload: params.providerPayload, correlationKey: params.correlationKey, executionStatus: "starting", timestamp });
			recomputeReportStatusInTransaction(tx, route.reportId, {
				reason: "provider_execution_started",
				routeId: route.id.toString(),
			});
			return { run, created, resumed: false };
		},
		{ behavior: "immediate" },
	);
}
