import type { Distribution, ProviderStats } from "@/lib/provider_stats/aggregate";
import { percent } from "@/lib/provider_stats/aggregate";
import { PROVIDER_VERDICTS } from "@/lib/provider_stats/route_outcome";
import { cn } from "@/web_lib/util";

import { formatMinutes, VERDICT_FILL, VERDICT_LABEL } from "./labels";

/** How the delivered reports were answered, as one stacked bar; each part names itself on hover. */
export function OutcomeBar({ stats, className }: { stats: ProviderStats; className?: string }) {
	const parts = PROVIDER_VERDICTS.filter((verdict) => stats.verdicts[verdict] > 0);
	if (!stats.delivered) return <div className={cn("h-2.5 rounded-full bg-muted", className)} title="No report delivered yet" />;
	return (
		<div className={cn("flex h-2.5 overflow-hidden rounded-full bg-muted", className)} role="img" aria-label={parts.map((verdict) => `${VERDICT_LABEL[verdict]} ${stats.verdicts[verdict]}`).join(", ")}>
			{parts.map((verdict) => (
				<div key={verdict} className={VERDICT_FILL[verdict]} style={{ width: `${(stats.verdicts[verdict] / stats.delivered) * 100}%` }} title={`${VERDICT_LABEL[verdict]}: ${stats.verdicts[verdict]} (${percent(stats.verdicts[verdict], stats.delivered)} %)`} />
			))}
		</div>
	);
}

export function OutcomeLegend({ stats }: { stats: ProviderStats }) {
	return (
		<ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
			{PROVIDER_VERDICTS.filter((verdict) => stats.verdicts[verdict] > 0).map((verdict) => (
				<li key={verdict} className="inline-flex items-center gap-1.5">
					<span className={cn("size-2 rounded-full", VERDICT_FILL[verdict])} />
					{VERDICT_LABEL[verdict]} <span className="tabular-nums text-foreground">{stats.verdicts[verdict]}</span>
				</li>
			))}
		</ul>
	);
}

/** Axis of the duration plots: one minute to sixty days, logarithmic, so minutes and weeks both read. */
const AXIS_MIN = 1;
const AXIS_MAX = 60 * 24 * 60;
const TICKS: Array<[number, string]> = [[1, "1 min"], [60, "1 h"], [24 * 60, "1 d"], [7 * 24 * 60, "1 wk"], [30 * 24 * 60, "30 d"]];

function position(minutes: number): number {
	const clamped = Math.min(AXIS_MAX, Math.max(AXIS_MIN, minutes));
	return (Math.log(clamped) - Math.log(AXIS_MIN)) / (Math.log(AXIS_MAX) - Math.log(AXIS_MIN));
}

/** A fixed vertical spread per dot, so equal values stay visible and the picture never changes between renders. */
function jitter(index: number): number {
	return ((index * 7919) % 13) / 12;
}

/**
 * Every duration as a dot on a log scale, with the median marked and the
 * middle half shaded: the tail a mean would hide stays in view.
 */
export function StripPlot({ distribution, label }: { distribution: Distribution; label: string }) {
	const left = (minutes: number) => `${position(minutes) * 100}%`;
	return (
		<figure className="space-y-1">
			<figcaption className="flex items-baseline justify-between gap-2 text-sm">
				<span className="font-medium">{label}</span>
				<span className="text-muted-foreground">
					{distribution.count ? <>median <span className="font-semibold tabular-nums text-foreground">{formatMinutes(distribution.median)}</span> · n = {distribution.count}</> : "no data yet"}
				</span>
			</figcaption>
			{distribution.count ? <>
			<div className="relative h-12 rounded-md bg-muted/40" role="img" aria-label={`${label}: ${distribution.count} values, median ${formatMinutes(distribution.median)}`}>
				{TICKS.map(([minutes]) => <div key={minutes} className="absolute inset-y-0 w-px bg-border" style={{ left: left(minutes) }} />)}
				{distribution.p25 !== undefined && distribution.p75 !== undefined ? (
					<div className="absolute inset-y-1 rounded-sm bg-primary/10" style={{ left: left(distribution.p25), width: `max(2px, ${(position(distribution.p75) - position(distribution.p25)) * 100}%)` }} title={`Middle half: ${formatMinutes(distribution.p25)} to ${formatMinutes(distribution.p75)}`} />
				) : null}
				{distribution.values.map((value, index) => (
					<div key={index} className="absolute size-1.5 -translate-x-1/2 rounded-full bg-primary/60" style={{ left: left(value), top: `${8 + jitter(index) * 28}px` }} title={formatMinutes(value)} />
				))}
				{distribution.median !== undefined ? <div className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground" style={{ left: left(distribution.median) }} title={`Median ${formatMinutes(distribution.median)}`} /> : null}
			</div>
			<div className="relative h-4 text-[11px] text-muted-foreground">
				{TICKS.map(([minutes, text], index) => <span key={minutes} className={cn("absolute whitespace-nowrap", index === 0 ? "" : index === TICKS.length - 1 ? "-translate-x-full" : "-translate-x-1/2")} style={{ left: left(minutes) }}>{text}</span>)}
			</div>
			</> : null}
		</figure>
	);
}

/** From delivered to taken down, each step a share of the delivered reports. */
export function Funnel({ stats, takedownLabel }: { stats: ProviderStats; takedownLabel: string }) {
	const answered = stats.delivered - stats.verdicts.no_reply - stats.verdicts.bounced;
	const steps: Array<{ label: string; value: number; base: number; note?: string }> = [
		{ label: "Delivered", value: stats.delivered, base: stats.delivered },
		{ label: "Answered", value: answered, base: stats.delivered },
		{ label: "Acknowledged", value: stats.verdicts.acknowledged, base: stats.delivered },
		{ label: takedownLabel, value: stats.takenDown, base: stats.checked, note: `of ${stats.checked} sites checked${stats.siteDown > stats.takenDown ? ` · ${stats.siteDown - stats.takenDown} more went down through another layer` : ""}` },
	];
	return (
		<div className="space-y-2">
			{steps.map((step) => {
				const share = percent(step.value, step.base);
				return (
					<div key={step.label} className="grid grid-cols-[7.5rem_1fr_5.5rem] items-center gap-3 text-sm sm:grid-cols-[9.5rem_1fr_6rem]">
						<span className="text-muted-foreground">{step.label}</span>
						<div className="h-5 rounded bg-muted">
							<div className="h-5 rounded bg-primary/70" style={{ width: `${share ?? 0}%` }} />
						</div>
						<span className="text-right tabular-nums">
							{step.value}
							<span className="text-muted-foreground"> {share === undefined ? "" : `· ${share} %`}</span>
						</span>
						{step.note ? <span className="col-span-3 -mt-1.5 text-xs text-muted-foreground sm:col-span-1 sm:col-start-2">{step.note}</span> : null}
					</div>
				);
			})}
		</div>
	);
}
