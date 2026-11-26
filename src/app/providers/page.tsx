import type { Metadata } from "next";
import Link from "next/link";

import { OutcomeBar } from "@/components/provider_stats/charts";
import { ProviderAvatar } from "@/components/reports/ProviderAvatar";
import { formatMinutes, formatPercent, ROLE_MEASURE, ROLE_TITLE, VERDICT_FILL, VERDICT_LABEL } from "@/components/provider_stats/labels";
import { Figure, PageShell } from "@/components/provider_stats/PageShell";
import { LOW_DATA_THRESHOLD, percent, type ProviderStats } from "@/lib/provider_stats/aggregate";
import { PROVIDER_VERDICTS } from "@/lib/provider_stats/route_outcome";
import { getProviderOverview, type RoleOverview } from "@/lib/provider_stats/views";
import { cn } from "@/lib/util/cn";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "How providers respond to phishing reports",
	description: "Every phishing report Phishing Support sent, by registrar, hosting provider, CDN and blocklist: who answered, who acknowledged or rejected, how fast, and whether the site actually went down.",
	alternates: { canonical: "/providers" },
};

const SORTS = {
	reports: { label: "Reports", value: (stats: ProviderStats) => stats.delivered },
	takedown: { label: "Takedown rate", value: (stats: ProviderStats) => percent(stats.takenDown, stats.checked) ?? -1 },
	acknowledged: { label: "Acknowledged", value: (stats: ProviderStats) => percent(stats.verdicts.acknowledged, stats.delivered) ?? -1 },
	reply: { label: "Fastest reply", value: (stats: ProviderStats) => -(stats.replyMinutes.median ?? Number.MAX_SAFE_INTEGER) },
} as const;
type Sort = keyof typeof SORTS;

function sortOf(value: string | string[] | undefined): Sort {
	return typeof value === "string" && value in SORTS ? (value as Sort) : "reports";
}

function ranked(providers: readonly ProviderStats[], sort: Sort): ProviderStats[] {
	return [...providers].sort((a, b) => SORTS[sort].value(b) - SORTS[sort].value(a) || b.delivered - a.delivered);
}

function Rate({ part, whole, title }: { part: number; whole: number; title?: string }) {
	const share = percent(part, whole);
	return <span title={title ?? `${part} of ${whole}`} className={cn("tabular-nums", share === undefined && "text-muted-foreground")}>{formatPercent(share)}</span>;
}

function ProviderTable({ providers, icons }: { providers: readonly ProviderStats[]; icons: Record<string, string> }) {
	return (
		<div className="overflow-x-auto rounded-xl border">
			<table className="w-full min-w-[60rem] text-sm">
				<thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground [&_th]:whitespace-nowrap">
					<tr>
						<th className="w-64 min-w-48 px-4 py-2.5 font-medium">Provider</th>
						<th className="px-3 py-2.5 text-right font-medium" title="Reports the provider received">Reports</th>
						<th className="w-48 px-3 py-2.5 font-medium">Answers</th>
						<th className="px-3 py-2.5 text-right font-medium" title="Confirmed receipt, is investigating, or said it acted">Acknowledged</th>
						<th className="px-3 py-2.5 text-right font-medium" title="Declined, or its abuse mailbox is not monitored">Rejected</th>
						<th className="px-3 py-2.5 text-right font-medium" title="Sites taken down through this provider's layer, of the sites checked">Taken down</th>
						<th className="px-3 py-2.5 text-right font-medium" title="Median time from report to takedown">To takedown</th>
						<th className="px-3 py-2.5 text-right font-medium" title="Median time from report to the first answer, automatic receipts included">First reply</th>
						<th className="px-4 py-2.5 text-right font-medium" title="Follow-ups we sent, and refusals they turned around">Follow-ups</th>
					</tr>
				</thead>
				<tbody className="divide-y">
					{providers.map((stats) => (
						<tr key={stats.organisation.slug} className="hover:bg-muted/30">
							<td className="px-4 py-2.5 [overflow-wrap:anywhere]">
								<div className="flex items-center gap-2.5">
									<ProviderAvatar name={stats.organisation.name} icon={icons[stats.organisation.slug] ?? null} />
									<div className="min-w-0">
										<Link href={`/providers/${stats.organisation.slug}`} className="font-medium text-foreground hover:underline">{stats.organisation.name}</Link>
										{stats.notDelivered ? <span className="ml-2 whitespace-nowrap text-xs text-muted-foreground" title="Reports never filed: our delivery failed or the provider's form refused the submission. They count neither for nor against the provider.">+{stats.notDelivered} not filed</span> : null}
									</div>
								</div>
							</td>
							<td className="px-3 py-2.5 text-right tabular-nums">{stats.delivered}</td>
							<td className="px-3 py-2.5"><OutcomeBar stats={stats} /></td>
							<td className="px-3 py-2.5 text-right"><Rate part={stats.verdicts.acknowledged} whole={stats.delivered} /></td>
							<td className="px-3 py-2.5 text-right"><Rate part={stats.verdicts.rejected + stats.verdicts.not_monitored} whole={stats.delivered} title={`${stats.verdicts.rejected} rejected, ${stats.verdicts.not_monitored} unmonitored mailbox`} /></td>
							<td className="px-3 py-2.5 text-right"><Rate part={stats.takenDown} whole={stats.checked} title={`${stats.takenDown} of ${stats.checked} checked sites`} /></td>
							<td className="px-3 py-2.5 text-right tabular-nums">{formatMinutes(stats.takedownMinutes.median)}</td>
							<td className="px-3 py-2.5 text-right tabular-nums">{formatMinutes(stats.replyMinutes.median)}</td>
							<td className="px-4 py-2.5 text-right tabular-nums">{stats.followUps}{stats.overturned ? <span className="text-emerald-700" title="Refusals turned into acknowledgement by a follow-up"> · {stats.overturned}↺</span> : null}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function RoleSection({ entry, sort, icons }: { entry: RoleOverview; sort: Sort; icons: Record<string, string> }) {
	const { total } = entry;
	const providers = ranked(entry.providers, sort);
	const main = providers.filter((stats) => stats.delivered >= LOW_DATA_THRESHOLD);
	const few = providers.filter((stats) => stats.delivered < LOW_DATA_THRESHOLD);
	return (
		<section id={entry.role} className="scroll-mt-6 space-y-4">
			<div className="max-w-3xl space-y-1">
				<h2 className="text-xl font-semibold tracking-tight">{ROLE_TITLE[entry.role]}</h2>
				<p className="text-pretty text-sm text-muted-foreground">{ROLE_MEASURE[entry.role]}</p>
				<p className="pt-1 text-sm">
					{total.delivered} reports · <Rate part={total.verdicts.acknowledged} whole={total.delivered} /> acknowledged · <Rate part={total.takenDown} whole={total.checked} /> taken down · median reply {formatMinutes(total.replyMinutes.median)}
				</p>
			</div>
			{main.length ? <ProviderTable providers={main} icons={icons} /> : null}
			{few.length ? (
				<details className="group rounded-xl border border-dashed" open={!main.length}>
					<summary className="cursor-pointer list-none px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
						<span aria-hidden className="group-open:hidden">▸</span><span aria-hidden className="hidden group-open:inline">▾</span> {few.length} {few.length === 1 ? "provider" : "providers"} with fewer than {LOW_DATA_THRESHOLD} reports: too few for their rates to say much
					</summary>
					<div className="p-2 pt-0"><ProviderTable providers={few} icons={icons} /></div>
				</details>
			) : null}
		</section>
	);
}

export default async function ProvidersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const sort = sortOf((await searchParams).sort);
	const overview = await getProviderOverview();
	return (
		<PageShell current="/providers">
			<header className="space-y-6">
				<div className="max-w-3xl space-y-3">
					<h1 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">How providers respond to phishing reports</h1>
					<p className="text-pretty text-lg text-muted-foreground">
						Every report Phishing Support sent, grouped by the company that received it and the part it plays for the site. What they answered, how fast, and whether the site then actually went down.
					</p>
				</div>
				<div className="grid grid-cols-2 gap-6 border-y py-5 sm:grid-cols-4">
					<Figure value={overview.reports} label="reports" />
					<Figure value={overview.providers} label="providers contacted" />
					<Figure value={overview.sitesChecked} label="sites checked for takedown" />
					<Figure value={overview.sitesDown} label="of them down now" />
				</div>
				<div className="flex flex-wrap items-center justify-between gap-4">
					<nav className="flex flex-wrap gap-2 text-sm" aria-label="Roles">
						{overview.roles.map((entry) => <a key={entry.role} href={`#${entry.role}`} className="rounded-full border px-3 py-1 hover:bg-muted">{ROLE_TITLE[entry.role]} <span className="text-muted-foreground">{entry.providers.length}</span></a>)}
					</nav>
					<div className="flex flex-wrap items-center gap-1 text-sm">
						<span className="mr-1 text-muted-foreground">Sort</span>
						{(Object.keys(SORTS) as Sort[]).map((key) => <Link key={key} href={key === "reports" ? "/providers" : `/providers?sort=${key}`} scroll={false} className={cn("whitespace-nowrap rounded-md px-2.5 py-1", key === sort ? "bg-foreground text-background" : "hover:bg-muted")}>{SORTS[key].label}</Link>)}
					</div>
				</div>
				<ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
					{PROVIDER_VERDICTS.map((verdict) => <li key={verdict} className="inline-flex items-center gap-1.5"><span className={cn("size-2 rounded-full", VERDICT_FILL[verdict])} />{VERDICT_LABEL[verdict]}</li>)}
				</ul>
			</header>

			{overview.roles.map((entry) => <RoleSection key={entry.role} entry={entry} sort={sort} icons={overview.icons} />)}

			<Methodology />
		</PageShell>
	);
}

/** The clocks and their accuracy, stated where the numbers are. */
function Methodology() {
	return (
		<section id="method" className="max-w-3xl space-y-3 border-t pt-8 text-sm text-muted-foreground">
			<h2 className="text-base font-semibold text-foreground">How this is measured</h2>
			<ul className="list-disc space-y-1.5 pl-5">
				<li><span className="text-foreground">Reports</span> count every report a provider received. Reports our side failed to deliver are shown apart and count neither for nor against it.</li>
				<li><span className="text-foreground">How they answered</span> is the provider&apos;s latest decisive answer: a classified reply mail, a notification stating a verdict, or the review state its portal or API reports. <span className="text-foreground">Acknowledged</span> means it confirmed receipt, is investigating, or said it acted; whether it acted shows in <span className="text-foreground">taken down</span>. A refusal a follow-up turned around counts as acknowledged and is marked ↺.</li>
				<li>A submission the provider&apos;s form refused before filing it (a duplicate, a failed captcha, a missing field) was never delivered and counts like our own delivery failures.</li>
				<li><span className="text-foreground">First reply</span> runs from delivery to the first answer of any kind, automatic receipts included. A review state read from a provider&apos;s portal or API is dated when it was first read: within the hour for current reports, but for reports filed before these reads began, only when they began.</li>
				<li><span className="text-foreground">Taken down</span>: each reported site is checked 1 h, 6 h, 24 h, 3 d, 7 d, 14 d and 30 d after the report (DNS, the domain&apos;s registry status, and the page itself). A takedown counts for a provider only when it happened after the provider got the report and through the layer it controls; a site that only stopped answering must fail two checks in a row.</li>
				<li><span className="text-foreground">To takedown</span> is only as exact as the check schedule: within the hour early on, within days for later checks. Sites first checked long after their report count as taken down, but without a time.</li>
				<li>Everything is public: each provider&apos;s page lists every report with the full correspondence.</li>
			</ul>
		</section>
	);
}
