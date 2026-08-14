import { and, desc, eq, inArray } from "drizzle-orm";

import { getDb } from "../../../../db";
import { abuseProviderRoutes, abuseProviderRuns, type AbuseProviderRun } from "../../../schema";
import {
	recordSkyvernTaskStartedWithTransition,
	type SkyvernTaskStartedTransition,
} from "../../../persistence/provider_runs";
import { GNAME_PROVIDER } from "../definition";

const ACTIVE_GNAME_RUN_STATUSES = [
	"pending",
	"starting",
	"task_creation_started",
	"running",
	"waiting_code",
	"sending_code",
	"unknown_external_state",
] as const;

/**
 * Return the most recent durable GNAME execution that may still own the
 * provider workflow. Code delivery and inbound matching use this provider
 * query instead of teaching generic run persistence about GNAME phases.
 */
export async function getLatestGnameActiveRunForRoute(routeId: bigint): Promise<AbuseProviderRun | undefined> {
	const db = await getDb();
	const route = await db
		.select({ providerRegistryKey: abuseProviderRoutes.providerRegistryKey })
		.from(abuseProviderRoutes)
		.where(eq(abuseProviderRoutes.id, routeId))
		.get();
	if (!route || route.providerRegistryKey !== GNAME_PROVIDER.key) return undefined;
	return db
		.select()
		.from(abuseProviderRuns)
		.where(
			and(
				eq(abuseProviderRuns.routeId, routeId),
				inArray(abuseProviderRuns.executionStatus, ACTIVE_GNAME_RUN_STATUSES),
			),
		)
		.orderBy(desc(abuseProviderRuns.createdAt))
		.limit(1)
		.get();
}

/**
 * Record the irreversible Skyvern task response and enter GNAME's durable
 * verification-code wait in one transaction. The generic primitive owns the
 * shared run/task/reconciliation bookkeeping; this wrapper owns the provider
 * lifecycle phase and its vocabulary.
 */
export async function recordGnameSkyvernTaskStarted(params: {
	runId: bigint;
	skyvernRunId: string;
}): Promise<boolean> {
	const transition: SkyvernTaskStartedTransition = {
		executionStatus: "waiting_code",
		routeStatus: "waiting_code",
	};
	return recordSkyvernTaskStartedWithTransition({
		...params,
		expectedProviderKey: GNAME_PROVIDER.key,
		transition,
	});
}
