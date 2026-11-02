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

/**
 * Phrases in a Skyvern run's `failure_reason` that classify one route's failure.
 * The public run API carries only this free text, so the groups below name the
 * upstream classifier category (failure_classifier.py, Skyvern v1.0.52) or the
 * production failure each phrase came from:
 *
 * - Planning limit (MAX_STEPS_EXCEEDED): "max steps", "maximum steps",
 *   "max number of", "step limit", and the "planning iterations" message the blob
 *   loop produced before its Fabric fix. Another route may still reach the site.
 * - Site verdict: anti-bot challenges (ANTI_BOT_DETECTION), explicit refusals
 *   ("blocked by site", Weebly's "you have been blocked", Google Cloud Storage's
 *   "not available in your location"), navigation failures (NAVIGATION_FAILURE),
 *   and the transport errors a Tor exit produces.
 *
 * Bare words that also occur in browser or relay infrastructure text (for example
 * "blocked by a local policy", "service unavailable" from the Fabric API) are
 * deliberately absent: a route verdict must never hide a failure of our own
 * infrastructure, because that failure should be retried rather than walked past.
 */
const PLANNING_LIMIT_PHRASES = [
	"max steps", "maximum steps", "max number of", "step limit", "planning iteration",
] as const;
const SITE_VERDICT_PHRASES = [
	"captcha", "cloudflare", "turnstile", "bot detect", "bot block", "ip block", "request block",
	"anti-bot", "human verification", "verify you are human",
	// A site that refuses this visitor: "blocked by site", "you have been blocked", geo blocks.
	"blocked by site", "you have been blocked", "not available in your location",
	"failed to navigate", "redirect loop", "blank page", "scrapingfailedblankpage",
	"err_tunnel_connection_failed", "err_proxy_connection_failed", "err_connection_refused",
	"err_connection_reset", "err_connection_closed", "err_name_not_resolved", "err_empty_response",
	"navigation timed out", "navigation failed",
] as const;
/**
 * Status codes a site answers with, matched as a whole token. A bare "404" or
 * "http 4" phrase also appears in unrelated browser and relay text.
 */
const SITE_HTTP_STATUS = /\bHTTP (?:4\d\d|5\d\d)\b/;
/**
 * Chromium navigation errors (`net::ERR_*`) describe what happened on the route
 * to the site: timeouts, resets, refusals, and DNS failures. They are the family
 * that a different egress can change, so the whole family is a route verdict.
 */
const CHROMIUM_NAVIGATION_ERROR = /\bnet::ERR_[A-Z_]+\b/;

/**
 * Turn a non-completed Skyvern terminal run into the route verdict it proves.
 * A planning limit and a site-level verdict advance the walk; anything else is an
 * infrastructure or unknown failure and stays retryable.
 */
export function routeVerdictForFailedRun(egress: FabricEgress, status: string, failureReason: string | undefined): Error {
	const reason = failureReason ?? "no failure reason";
	const normalized = reason.toLowerCase();
	if (PLANNING_LIMIT_PHRASES.some((phrase) => normalized.includes(phrase))) return new SkyvernPlanningLimitError(egress, reason);
	if (SITE_VERDICT_PHRASES.some((phrase) => normalized.includes(phrase)) || SITE_HTTP_STATUS.test(reason) || CHROMIUM_NAVIGATION_ERROR.test(reason)) {
		return new WebsiteUnreachableError(egress, reason);
	}
	return new Error(`Skyvern exfiltration probe ended in ${status} via ${egress}: ${reason}`);
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
