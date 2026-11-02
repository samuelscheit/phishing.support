import type { FabricEgress } from "../browser/fabric";
import { WebsiteUnreachableError } from "../website_archive";

/**
 * Egress routes a probe walks, in order. The labels and the order mirror the
 * capture path (`website_archive.ts`): Tor keeps the server's address away from
 * the kit, the server IP answers Tor-blocking sites, and the residential exit
 * answers cloakers that show Tor and datacenter visitors a decoy.
 */
export const PROBE_EGRESS_ORDER: readonly FabricEgress[] = ["phishing", "reporting", "residential"];

/**
 * Skyvern stopped planning a route before the form flow finished, for example a
 * blob loader page that never becomes a real document (`150 planning iterations`).
 * Another egress can still reach the site, so this advances the probe.
 */
export class SkyvernPlanningLimitError extends Error {
	constructor(readonly egress: FabricEgress, readonly reason: string) {
		super(`Skyvern planning limit reached via ${egress}: ${reason}`);
		this.name = "SkyvernPlanningLimitError";
	}
}

export type ProbeRouteOutcome = "next_route" | "infrastructure";

/**
 * Decide what a failed route attempt means. A site that cannot be reached over
 * a route, and a planning limit, say nothing about the other routes, so the
 * probe advances. A browser-service failure, or anything unexpected, is
 * rethrown so the job retries rather than reporting a site verdict.
 */
export function probeRouteOutcome(error: unknown): ProbeRouteOutcome {
	if (error instanceof WebsiteUnreachableError || error instanceof SkyvernPlanningLimitError) return "next_route";
	return "infrastructure";
}

export type ProbeRouteFailure = { egress: FabricEgress; error: unknown };

export type ProbeRouteResult<T> =
	| { outcome: "completed"; egress: FabricEgress; value: T }
	| { outcome: "exhausted"; reason: "routes" | "budget"; failures: ProbeRouteFailure[] };

/**
 * Run one attempt per egress until an attempt completes. Route verdicts advance
 * the walk; any other failure stops it and is rethrown, so a transient browser
 * fault retries the job instead of consuming every route. The investigation
 * budget is shared by all routes: once it has elapsed, no further route starts.
 */
export async function runProbeRoutes<T>(params: {
	budget?: AbortSignal;
	attempt(egress: FabricEgress): Promise<{ egress: FabricEgress; value: T }>;
}): Promise<ProbeRouteResult<T>> {
	const failures: ProbeRouteFailure[] = [];
	for (const egress of PROBE_EGRESS_ORDER) {
		if (params.budget?.aborted) return { outcome: "exhausted", reason: "budget", failures };
		try {
			const completed = await params.attempt(egress);
			return { outcome: "completed", egress: completed.egress, value: completed.value };
		} catch (error) {
			if (probeRouteOutcome(error) !== "next_route") throw error;
			failures.push({ egress, error });
		}
	}
	return { outcome: "exhausted", reason: "routes", failures };
}
