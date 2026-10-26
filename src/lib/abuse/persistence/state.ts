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

/** Routes whose report reached the provider (delivered mail awaits a reply). */
const DELIVERED_ROUTE_STATUSES = new Set<AbuseRouteStatus>(["submitted", "acknowledged", "awaiting_provider_reply"]);

/**
 * Public report status derived from its routes. Work in progress is shown
 * first; once every route is settled, any delivered route is a success for
 * the report even when another provider failed or is ambiguous, so a single
 * unreachable provider never hides reports that were actually filed.
 */
export function aggregateReportStatus(routeStatuses: AbuseRouteStatus[]): AbuseReportStatus {
	if (routeStatuses.length === 0) return "no_route";
	if (routeStatuses.some((status) => ["running", "waiting_code", "escalating_to_portal"].includes(status))) return "running";
	if (routeStatuses.includes("queued")) return "queued";
	if (routeStatuses.includes("verified")) return "verifying";
	if (routeStatuses.includes("resolving")) return "resolving";

	const actionable = routeStatuses.filter((status) => status !== "no_route");
	const delivered = actionable.filter((status) => DELIVERED_ROUTE_STATUSES.has(status));
	if (delivered.length > 0) {
		if (delivered.length < actionable.length) return "partially_submitted";
		return delivered.includes("awaiting_provider_reply") ? "waiting_provider" : "submitted";
	}
	if (actionable.length === 0) return "no_route";
	if (actionable.includes("needs_human")) return "needs_human";
	if (actionable.every((status) => status === "insufficient_evidence")) return "insufficient_evidence";
	return "failed";
}
