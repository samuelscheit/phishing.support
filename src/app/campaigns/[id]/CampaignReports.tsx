"use client";

/**
 * The campaign's reports, one row per provider: the same few companies get
 * a report for every site, so what matters is how each deals with the whole
 * batch and which sites stand out. A row reads like the case page's report
 * row (role, standing, the provider's latest key sentence); expanded it lists
 * the sites, the unusual ones first, each leading to its case. Read-only, in
 * English like the case page's Reports tab.
 */
import { ChevronRight } from "lucide-react";

import { ROLE_LABEL } from "@/components/provider_stats/labels";
import { BUCKET_STYLE, ProviderAvatar, StandingPill, Steps } from "@/components/reports/standing";
import type { PublicCampaignSite, PublicSiteReport } from "@/lib/campaign/public_view";
import type { Locale } from "@/lib/i18n/locale";
import { routeBuckets, shortUtc, type RouteBucket } from "@/lib/submissions/report_view";
import { cn } from "@/lib/util/cn";
import { COPY } from "./copy";

type SiteReport = { site: PublicCampaignSite; report: PublicSiteReport };
type ProviderGroup = { organisation: string; role: PublicSiteReport["role"]; channel: string; entries: SiteReport[] };

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Every route of every site, by the company and role it reached; the company with the most sites first. */
export function providerGroups(sites: readonly PublicCampaignSite[]): ProviderGroup[] {
	const groups = new Map<string, ProviderGroup>();
	for (const site of sites) for (const report of site.reports) {
		const key = `${report.organisation}\u0000${report.role}`;
		const group = groups.get(key) ?? { organisation: report.organisation, role: report.role, channel: report.channel, entries: [] };
		group.entries.push({ site, report });
		groups.set(key, group);
	}
	return [...groups.values()].sort((a, b) => b.entries.length - a.entries.length || a.organisation.localeCompare(b.organisation));
}

/** The sites that stand out first: the rarest standing of the provider's batch, then the strongest, then by host. */
function unusualFirst(entries: readonly SiteReport[]): SiteReport[] {
	const counts = new Map<RouteBucket, number>();
	for (const { report } of entries) counts.set(report.bucket, (counts.get(report.bucket) ?? 0) + 1);
	return [...entries].sort((a, b) => counts.get(a.report.bucket)! - counts.get(b.report.bucket)!
		|| routeBuckets.indexOf(a.report.bucket) - routeBuckets.indexOf(b.report.bucket)
		|| a.site.host.localeCompare(b.site.host));
}

/** The provider's own latest words about any of the sites. */
function latestQuote(entries: readonly SiteReport[]): SiteReport | undefined {
	return entries.filter(({ report }) => report.quoted && report.line && report.at).sort((a, b) => b.report.at!.localeCompare(a.report.at!))[0];
}

function ProviderRow({ group, highlight }: { group: ProviderGroup; highlight?: string }) {
	const { entries } = group;
	const counts = routeBuckets.map((bucket) => ({ bucket, count: entries.filter(({ report }) => report.bucket === bucket).length })).filter(({ count }) => count > 0);
	const quote = latestQuote(entries);
	const sites = new Set(entries.map(({ site }) => site.key)).size;
	return (
		<details className="group border-t first:border-t-0">
			<summary className="flex cursor-pointer list-none flex-col gap-3 px-4 py-3 hover:bg-muted/30 sm:flex-row sm:items-start [&::-webkit-details-marker]:hidden">
				<div className="flex min-w-0 items-center gap-2.5 sm:w-52 sm:shrink-0">
					<ProviderAvatar name={group.organisation} />
					<div className="min-w-0">
						<div className="truncate text-sm font-medium">{group.organisation}</div>
						<div className="text-xs text-muted-foreground">{ROLE_LABEL[group.role].charAt(0).toUpperCase() + ROLE_LABEL[group.role].slice(1)} · {group.channel}</div>
					</div>
				</div>
				<div className="min-w-0 flex-1 space-y-1.5">
					<div className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={counts.map(({ bucket, count }) => `${count} ${BUCKET_STYLE[bucket].legend}`).join(", ")}>
						{counts.map(({ bucket, count }) => <span key={bucket} className={BUCKET_STYLE[bucket].fill} style={{ flexGrow: count }} />)}
					</div>
					<ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
						{counts.map(({ bucket, count }) => (
							<li key={bucket} className="inline-flex items-center gap-1.5"><span className={cn("size-2 rounded-sm", BUCKET_STYLE[bucket].fill)} aria-hidden /><span className="font-semibold text-foreground">{count}</span> {BUCKET_STYLE[bucket].legend}</li>
						))}
					</ul>
					{quote && <p className="line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]" title={quote.report.line}>“{quote.report.line}” <span className="whitespace-nowrap">· {quote.site.host}, {shortUtc(quote.report.at!)} UTC</span></p>}
				</div>
				<div className="flex shrink-0 items-center gap-2 self-end text-xs text-muted-foreground sm:self-start">
					{plural(sites, "site")}
					<ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden />
				</div>
			</summary>
			<ul className="divide-y border-t bg-muted/20">
				{unusualFirst(entries).map(({ site, report }) => (
					<li key={report.routeId} className={cn("grid gap-x-4 gap-y-1.5 px-4 py-2.5 text-xs sm:grid-cols-[minmax(0,1fr)_7.5rem_minmax(0,1.2fr)] sm:pl-[3.75rem]", site.host === highlight && "bg-amber-50")}>
						<div className="min-w-0">
							<a href={`/submissions/${site.submissionId}`} className="block truncate font-mono font-medium hover:underline" title={site.host}>{site.host}</a>
							<span className="block text-muted-foreground">{report.sentAt ? `Sent ${shortUtc(report.sentAt)} UTC` : "Not sent"}</span>
							{report.ticket && <span className="block truncate font-mono text-muted-foreground" title={report.ticket}>#{report.ticket}</span>}
						</div>
						<Steps steps={report.steps} />
						<div className="min-w-0 space-y-0.5">
							<StandingPill bucket={report.bucket}>{report.label}</StandingPill>
							{report.line && <p className="line-clamp-2 text-muted-foreground [overflow-wrap:anywhere]" title={report.line}>{report.quoted ? `“${report.line}”` : report.line}</p>}
							{report.next && <p className="text-muted-foreground"><span className="font-medium text-foreground">Next:</span> {report.next}</p>}
						</div>
					</li>
				))}
			</ul>
		</details>
	);
}

export function CampaignReports({ sites, highlight, locale }: { sites: PublicCampaignSite[]; highlight?: string; locale: Locale }) {
	const groups = providerGroups(sites);
	const note = COPY[locale].technicalNote;
	if (!groups.length) return <p className="py-10 text-center text-sm text-muted-foreground">No reports yet.</p>;
	return (
		<div lang="en" className="space-y-3">
			{note && <p className="text-sm text-muted-foreground">{note}</p>}
			<div className="overflow-hidden rounded-lg border bg-card">
				{groups.map((group) => <ProviderRow key={`${group.organisation}:${group.role}`} group={group} highlight={highlight} />)}
			</div>
		</div>
	);
}
