import type { AbuseProviderRun } from "../schema";
import { safePublicError } from "../security";
import { describeProviderReportStatus } from "../provider_status";
import { listProviderRunsForReport } from "./provider_runs";
import { getReportByTrackingToken, listRoutes, listTargets } from "./reports";

/** The token-authorized public read model. It deliberately omits primary keys and secrets. */
export async function getPublicStatus(token: string) {
	const report = await getReportByTrackingToken(token);
	if (!report) return undefined;
	const [targets, routes, runs] = await Promise.all([
		listTargets(report.id),
		listRoutes(report.id),
		listProviderRunsForReport(report.id),
	]);
	const latestRunByRoute = new Map<bigint, AbuseProviderRun>();
	for (const run of runs) if (!latestRunByRoute.has(run.routeId)) latestRunByRoute.set(run.routeId, run);
	const routesByTarget = new Map<bigint, Array<Record<string, unknown>>>();
	for (const route of routes) {
		const run = latestRunByRoute.get(route.id);
		const error = safePublicError(route.status, run?.failureReason);
		const item = {
			provider: route.providerDisplayName,
			routeType: route.routeType === "manual_unroutable" ? "manual/unroutable" : route.routeType,
			status: route.status,
			executionStatus: run?.executionStatus,
			confirmationId: run?.confirmationId,
			error,
			statusDescription: describeProviderReportStatus({
				status: route.status,
				executionStatus: run?.executionStatus,
				error,
			}),
		};
		const list = routesByTarget.get(route.targetId) ?? [];
		list.push(item);
		routesByTarget.set(route.targetId, list);
	}
	return {
		status: report.status,
		createdAt: report.createdAt.toISOString(),
		updatedAt: report.updatedAt.toISOString(),
		targets: targets.map((target) => ({
			target: target.normalizedTarget,
			type: target.targetType,
			status: target.resolutionStatus,
			disposition: safePublicError(target.resolutionStatus, target.disposition),
			providerRoutes: routesByTarget.get(target.id) ?? [],
		})),
	};
}
