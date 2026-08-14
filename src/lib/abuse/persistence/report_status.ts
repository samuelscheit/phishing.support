import { eq } from "drizzle-orm";

import { getDb } from "../../db";
import { abuseProviderRoutes, abuseReports, type AbuseReportStatus, type AbuseRouteStatus } from "../schema";
import { recordEvent, now } from "./shared";
import { aggregateReportStatus } from "./state";

/**
 * Route status is the authoritative lifecycle record. Keep the public
 * aggregate in the same transaction as each route transition so a delayed
 * worker cannot write an aggregate calculated from an obsolete snapshot.
 */
export function recomputeReportStatusInTransaction(
	tx: any,
	reportId: bigint,
	data: Record<string, unknown> = {},
): AbuseReportStatus | undefined {
	const report = tx.select({ status: abuseReports.status }).from(abuseReports).where(eq(abuseReports.id, reportId)).get();
	if (!report || report.status === "canceled") return report?.status as AbuseReportStatus | undefined;
	const routeStatuses = tx
		.select({ status: abuseProviderRoutes.status })
		.from(abuseProviderRoutes)
		.where(eq(abuseProviderRoutes.reportId, reportId))
		.all()
		.map((item: { status: AbuseRouteStatus }) => item.status);
	const aggregate = aggregateReportStatus(routeStatuses);
	if (aggregate === "resolving" && report.status === "verifying") return report.status;
	if (report.status === aggregate) return aggregate;
	const timestamp = now();
	tx.update(abuseReports).set({ status: aggregate, updatedAt: timestamp }).where(eq(abuseReports.id, reportId)).run();
	recordEvent(tx, {
		reportId,
		eventType: "report.status_changed",
		data: { from: report.status, to: aggregate, ...data },
	});
	return aggregate;
}

export async function recomputeReportStatus(reportId: bigint): Promise<AbuseReportStatus> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const status = recomputeReportStatusInTransaction(tx, reportId, { reason: "explicit_recompute" });
			if (!status) throw new Error(`Abuse report ${reportId.toString()} does not exist.`);
			return status;
		},
		{ behavior: "immediate" },
	);
}
