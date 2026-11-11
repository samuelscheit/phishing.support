import { AbuseRepository } from "../repository";
import type { AbuseTargetResolver } from "./shared";

export async function resolveReport(reportId: bigint, resolveTarget: AbuseTargetResolver): Promise<void> {
	const input = await AbuseRepository.getReportInput(reportId);
	if (!input) throw new Error("Abuse report no longer exists.");
	// A resolver job can be replayed after a lease expiry. Once another
	// worker has moved the report into verification/execution or a terminal
	// aggregate, this old job must not reopen it or enqueue duplicate work.
	if (!["accepted", "resolving"].includes(input.report.status)) return;
	if (input.report.status === "accepted") {
		await AbuseRepository.transitionReportStatus({ reportId, from: "accepted", to: "resolving" });
	}
	for (const target of input.targets) {
		const resolved = await resolveTarget({
			normalizedTarget: target.normalizedTarget,
			targetType: target.targetType,
			observedUrls: target.observedUrls,
		});
		await AbuseRepository.setTargetResolution({
			targetId: target.id,
			status: resolved.status,
			resolverSnapshot: resolved.resolverSnapshot,
			disposition: resolved.disposition,
		});
		for (const routeInput of resolved.routes) {
			const route = await AbuseRepository.upsertResolvedRoute(target.id, routeInput);
			if (route.status === "verified" && route.routeType === "provider_submission") {
				await AbuseRepository.enqueueJob({
					jobType: "submit_provider",
					reportId,
					routeId: route.id,
					payload: {},
					dedupeKey: `provider-submit:${route.id.toString()}`,
				});
			} else if (route.status === "verified" && route.routeType === "email") {
				await AbuseRepository.enqueueJob({
					jobType: "send_email",
					reportId,
					routeId: route.id,
					payload: {},
					dedupeKey: `email:${route.id.toString()}`,
				});
			}
		}
	}
	await AbuseRepository.recomputeReportStatus(reportId);
}
