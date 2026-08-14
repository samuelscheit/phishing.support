import type { AbuseReportStatus, AbuseRouteStatus } from "../schema";

/**
 * Terminal provider outcomes are never reopened by normal asynchronous work.
 * `delivery_failed` is intentionally excluded: an explicit SMTP failure or
 * correlated bounce is safe to retry with the same durable identity.
 */
export const IMMUTABLE_ROUTE_STATUSES = new Set<AbuseRouteStatus>([
	"submitted",
	"acknowledged",
	"provider_rejected",
	"insufficient_evidence",
	"no_route",
	"failed",
	"needs_human",
	"unknown_external_state",
]);

/** Outcomes that cannot be settled again by a provider-run callback. */
export const FINAL_OR_BLOCKED_ROUTE_STATUSES = new Set<AbuseRouteStatus>([
	"submitted",
	"acknowledged",
	"provider_rejected",
	"delivery_failed",
	"insufficient_evidence",
	"no_route",
	"failed",
	"needs_human",
	"unknown_external_state",
]);

export function aggregateReportStatus(routeStatuses: AbuseRouteStatus[]): AbuseReportStatus {
	if (routeStatuses.length === 0) return "no_route";
	if (routeStatuses.includes("needs_human")) return "needs_human";
	if (routeStatuses.includes("unknown_external_state")) return "failed";
	if (routeStatuses.some((status) => ["running", "waiting_code", "escalating_to_portal"].includes(status))) return "running";
	if (routeStatuses.includes("queued")) return "queued";
	if (routeStatuses.includes("verified")) return "verifying";
	if (routeStatuses.includes("resolving")) return "resolving";
	if (routeStatuses.includes("awaiting_provider_reply")) return "waiting_provider";

	const successful = routeStatuses.filter((status) => status === "submitted" || status === "acknowledged").length;
	if (successful === routeStatuses.length) return "submitted";
	if (successful > 0) return "partially_submitted";

	const routable = routeStatuses.filter((status) => status !== "no_route");
	if (routable.length === 0) return "no_route";
	if (routable.every((status) => status === "insufficient_evidence")) return "insufficient_evidence";
	return "failed";
}
