import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

import { ProviderAvatar } from "@/components/reports/ProviderAvatar";
import { RouteTimeline } from "@/components/reports/RouteTimeline";
import { Funnel, OutcomeBar, OutcomeLegend, StripPlot } from "@/components/provider_stats/charts";
import { formatMinutes, formatPercent, ROLE_LABEL, ROLE_MEASURE, SITE_STATE_LABEL, VERDICT_BADGE, VERDICT_LABEL } from "@/components/provider_stats/labels";
import { Figure, PageShell, Pagination } from "@/components/provider_stats/PageShell";
import { LOW_DATA_THRESHOLD, percent, routeTakedownOf, type ProviderStats } from "@/lib/provider_stats/aggregate";
import type { ProviderRole } from "@/lib/provider_stats/role";
import { getProviderPage, isProviderSlug, pageOf, type ProviderRouteDetail } from "@/lib/provider_stats/views";
import { plural } from "@/lib/util/values";
import { cn } from "@/lib/util/cn";
import { utcDate } from "@/lib/util/date_time";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const providerPage = cache(async (slug: string, page: number) => (isProviderSlug(slug) ? getProviderPage(slug, page) : undefined));

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
	const detail = await providerPage((await params).slug, pageOf((await searchParams).page));
	if (!detail) return { title: "Provider not found", robots: { index: false, follow: false } };
	const delivered = detail.stats.reduce((sum, stats) => sum + stats.delivered, 0);
	return {
		title: `${detail.organisation.name}: response to phishing reports`,
		description: `${delivered} phishing reports sent to ${detail.organisation.name}: how it answered, how fast, and whether the sites went down, with the full correspondence.`,
		alternates: { canonical: `/providers/${detail.organisation.slug}` },
	};
}

/** What counts as this role's takedown, in the funnel's words. */
const TAKEDOWN_STEP: Partial<Record<ProviderRole, string>> = { registrar: "Domain taken down", host: "Site taken down", cdn: "Warning shown" };

function RoleBlock({ stats }: { stats: ProviderStats }) {
	const low = stats.delivered < LOW_DATA_THRESHOLD;
	return (
		<section className="space-y-6 rounded-2xl border p-5 sm:p-6">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="max-w-2xl space-y-1">
					<h2 className="text-lg font-semibold tracking-tight capitalize">As {ROLE_LABEL[stats.role]}</h2>
					<p className="text-pretty text-sm text-muted-foreground">{ROLE_MEASURE[stats.role]}</p>
				</div>
				{low ? <span className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs text-amber-800">Few reports: rates say little</span> : null}
			</div>
			<div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
				<Figure value={stats.delivered} label="reports received" hint={stats.notDelivered ? `${stats.notDelivered} more were never filed: our delivery failed or the provider's form refused them` : undefined} />
				<Figure value={formatPercent(percent(stats.verdicts.acknowledged, stats.delivered))} label="acknowledged" />
				<Figure value={formatPercent(percent(stats.takenDown, stats.checked))} label={`taken down (${stats.takenDown} of ${stats.checked})`} />
				<Figure value={stats.followUps} label={stats.overturned ? `follow-ups · ${stats.overturned} turned around` : "follow-ups sent"} hint={stats.unansweredDecisions ? `${stats.unansweredDecisions} decisions were looked at and left unanswered` : undefined} />
			</div>
			<div className="space-y-2">
				<OutcomeBar stats={stats} className="h-3" />
				<OutcomeLegend stats={stats} />
			</div>
			<div className="grid gap-8 lg:grid-cols-2">
				<Funnel stats={stats} takedownLabel={TAKEDOWN_STEP[stats.role] ?? "Site went down"} />
				<div className="space-y-4">
					<StripPlot distribution={stats.replyMinutes} label="Time to first reply" />
					<StripPlot distribution={stats.decisionMinutes} label="Time to decision" />
					<StripPlot distribution={stats.takedownMinutes} label="Time to takedown" />
				</div>
			</div>
			<p className="text-xs text-muted-foreground">Reports from {utcDate(stats.firstReportAt)} to {utcDate(stats.lastReportAt)}.</p>
		</section>
	);
}

function caseHref(detail: ProviderRouteDetail): string {
	return detail.record.submissionId ? `/submissions/${detail.record.submissionId}` : `/reports/${detail.record.reportId}`;
}

function RouteEntry({ detail }: { detail: ProviderRouteDetail }) {
	const { record, report, route } = detail;
	const takedown = routeTakedownOf(record);
	const state = record.takedown?.state;
	return (
		<li className="rounded-xl border">
			<details className="group">
				<summary className="flex cursor-pointer list-none [&::-webkit-details-marker]:hidden flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-muted/30">
					<span className="w-24 shrink-0 text-sm tabular-nums text-muted-foreground">{utcDate(record.reportedAt)}</span>
					<span className="min-w-[12rem] flex-1 truncate font-mono text-sm">{record.target}</span>
					<span className="text-xs text-muted-foreground">{ROLE_LABEL[record.role]}</span>
					<span className={cn("rounded-full border px-2 py-0.5 text-xs", VERDICT_BADGE[record.outcome.verdict])}>{VERDICT_LABEL[record.outcome.verdict]}</span>
					<span className={cn("whitespace-nowrap text-xs sm:w-56 sm:text-right", takedown?.byThisLayer ? "text-emerald-700" : record.takedown?.stillOnline ? "text-red-700" : "text-muted-foreground")}>
						{state ? SITE_STATE_LABEL[state] : "Not checked"}
						{takedown?.minutes !== undefined ? ` after ${formatMinutes(takedown.minutes)}` : ""}
					</span>
					<span className="text-xs text-muted-foreground group-open:hidden">{plural(record.outcome.inbound + record.outcome.outbound, "message", "messages")} <span aria-hidden>▾</span></span>
				</summary>
				<div className="space-y-3 border-t p-4">
					<Link href={caseHref(detail)} className="text-sm text-primary hover:underline">Open the whole case →</Link>
					<RouteTimeline route={route} report={report} />
				</div>
			</details>
		</li>
	);
}

/**
 * One provider's record: its statistics for each part it played, then every
 * report it received with the full correspondence, newest first.
 */
export default async function ProviderPage({ params, searchParams }: Props) {
	const { slug } = await params;
	const detail = await providerPage(slug, pageOf((await searchParams).page));
	if (!detail) notFound();
	const total = detail.records.length;
	return (
		<PageShell current={undefined}>
			<header className="space-y-3">
				<Link href="/providers" className="text-sm text-muted-foreground hover:text-foreground">← All providers</Link>
				<h1 className="flex items-center gap-3 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
					<ProviderAvatar name={detail.organisation.name} icon={detail.icon} size="large" />
					<span className="min-w-0 [overflow-wrap:anywhere]">{detail.organisation.name}</span>
				</h1>
				<p className="text-lg text-muted-foreground">
					{total} {total === 1 ? "report" : "reports"} as {detail.stats.map((stats) => ROLE_LABEL[stats.role]).join(" and ")}.{" "}
					<Link href={`/reports?provider=${detail.organisation.slug}`} className="text-primary hover:underline">Browse them with the other providers of each case</Link>.
				</p>
			</header>
			{detail.stats.map((stats) => <RoleBlock key={stats.role} stats={stats} />)}
			<section className="space-y-4">
				<h2 className="text-xl font-semibold tracking-tight">Every report</h2>
				<ul className="space-y-2">{detail.routes.map((route) => <RouteEntry key={String(route.record.routeId)} detail={route} />)}</ul>
				<Pagination page={detail.page} pageCount={detail.pageCount} href={(page) => `/providers/${detail.organisation.slug}${page > 1 ? `?page=${page}` : ""}`} />
			</section>
		</PageShell>
	);
}
