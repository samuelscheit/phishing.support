import type { AbuseRouteType, AbuseTargetType } from "../abuse/schema";
import type { Takedown } from "../liveness/layer";
import type { Organisation } from "./organisation";
import type { ProviderRole } from "./role";
import { PROVIDER_VERDICTS, routeVerdicts, type RouteOutcome, type RouteVerdict } from "./route_outcome";
import { minutesBetween } from "../util/date_time";

/** One provider route with everything the statistics need. */
export type ProviderRouteRecord = {
	routeId: bigint;
	reportId: bigint;
	submissionId: bigint | null;
	target: string;
	targetType: AbuseTargetType;
	organisation: Organisation;
	role: ProviderRole;
	channel: AbuseRouteType;
	reportedAt: Date;
	outcome: RouteOutcome;
	/** Undefined when the site was never checked (mail targets, or no check ran yet). */
	takedown?: Takedown;
};

/** The layer whose action a role is credited with; the other roles are credited with any takedown. */
const LAYER_OF_ROLE: Partial<Record<ProviderRole, Takedown["layer"]>> = { registrar: "registrar", host: "host", cdn: "cdn" };

/** What a route's report achieved at the site, from the provider's point of view. */
export type RouteTakedown = {
	/** The site went down after this provider received the report. */
	siteDown: boolean;
	/** …and through the layer this provider controls. */
	byThisLayer: boolean;
	/** Minutes from delivery to the takedown, when the checks pin the time down. */
	minutes?: number;
};

export function routeTakedownOf(record: Pick<ProviderRouteRecord, "role" | "outcome" | "takedown">): RouteTakedown | undefined {
	const { takedown, outcome } = record;
	if (!takedown || !outcome.sentAt) return undefined;
	const siteDown = Boolean(takedown.downAt && takedown.downAt.getTime() >= outcome.sentAt.getTime());
	const layer = LAYER_OF_ROLE[record.role];
	const byThisLayer = siteDown && (layer === undefined || takedown.layer === layer);
	const minutes = siteDown && takedown.exactTime ? minutesBetween(outcome.sentAt, takedown.downAt!) : undefined;
	return { siteDown, byThisLayer, ...(minutes === undefined ? {} : { minutes }) };
}

/** A distribution of durations in minutes: its quartiles for the table and its values for a plot. */
export type Distribution = { count: number; median?: number; p25?: number; p75?: number; values: number[] };

export type ProviderStats = {
	organisation: Organisation;
	role: ProviderRole;
	/** Every route, delivered or not. */
	routes: number;
	/** Routes the provider received, the base of every rate. */
	delivered: number;
	notDelivered: number;
	pending: number;
	verdicts: Record<RouteVerdict, number>;
	replyMinutes: Distribution;
	decisionMinutes: Distribution;
	takedownMinutes: Distribution;
	/** Delivered routes whose site was checked at least once. */
	checked: number;
	takenDown: number;
	/** Sites that went down after the report through any layer; `takenDown` counts this provider's layer only. */
	siteDown: number;
	followUps: number;
	overturned: number;
	unansweredDecisions: number;
	firstReportAt: Date;
	lastReportAt: Date;
};

/** Below this many delivered reports a provider's rates say little. */
export const LOW_DATA_THRESHOLD = 5;

/** Quartiles by the nearest-rank method: every value shown is one that happened. */
export function distributionOf(values: readonly number[]): Distribution {
	const sorted = [...values].sort((a, b) => a - b);
	const rank = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
	if (!sorted.length) return { count: 0, values: [] };
	return { count: sorted.length, median: rank(0.5), p25: rank(0.25), p75: rank(0.75), values: sorted };
}

function emptyVerdicts(): Record<RouteVerdict, number> {
	return Object.fromEntries(routeVerdicts.map((verdict) => [verdict, 0])) as Record<RouteVerdict, number>;
}

/** The statistics of one group of routes (one provider in one role, or any other grouping). */
export function statsOf(records: readonly ProviderRouteRecord[], organisation: Organisation, role: ProviderRole): ProviderStats {
	const verdicts = emptyVerdicts();
	const reply: number[] = [];
	const decision: number[] = [];
	const takedown: number[] = [];
	let checked = 0, takenDown = 0, siteDown = 0, followUps = 0, overturned = 0, unansweredDecisions = 0;
	for (const record of records) {
		const { outcome } = record;
		verdicts[outcome.verdict]++;
		if (!PROVIDER_VERDICTS.includes(outcome.verdict)) continue;
		if (outcome.sentAt && outcome.firstReplyAt) reply.push(minutesBetween(outcome.sentAt, outcome.firstReplyAt));
		if (outcome.sentAt && outcome.decisionAt) decision.push(minutesBetween(outcome.sentAt, outcome.decisionAt));
		followUps += outcome.followUps;
		if (outcome.overturnedByFollowUp) overturned++;
		unansweredDecisions += outcome.unansweredDecisions;
		const result = routeTakedownOf(record);
		if (!result) continue;
		checked++;
		if (result.siteDown) siteDown++;
		if (result.byThisLayer) takenDown++;
		if (result.minutes !== undefined && result.byThisLayer) takedown.push(result.minutes);
	}
	const times = records.map((record) => record.reportedAt.getTime());
	return {
		organisation,
		role,
		routes: records.length,
		delivered: PROVIDER_VERDICTS.reduce((sum, verdict) => sum + verdicts[verdict], 0),
		notDelivered: verdicts.not_delivered,
		pending: verdicts.pending,
		verdicts,
		replyMinutes: distributionOf(reply),
		decisionMinutes: distributionOf(decision),
		takedownMinutes: distributionOf(takedown),
		checked,
		takenDown,
		siteDown,
		followUps,
		overturned,
		unansweredDecisions,
		firstReportAt: new Date(Math.min(...times)),
		lastReportAt: new Date(Math.max(...times)),
	};
}

/** One statistics row per organisation and role, busiest first. */
export function providerStatsOf(records: readonly ProviderRouteRecord[]): ProviderStats[] {
	return [...Map.groupBy(records, (record) => `${record.organisation.slug}\u0000${record.role}`).values()]
		.map((group) => statsOf(group, group[0]!.organisation, group[0]!.role))
		.sort((a, b) => b.delivered - a.delivered || b.routes - a.routes || a.organisation.name.localeCompare(b.organisation.name));
}

/** A share in whole percent, or undefined without a base. */
export function percent(part: number, whole: number): number | undefined {
	return whole > 0 ? Math.round((part / whole) * 100) : undefined;
}
