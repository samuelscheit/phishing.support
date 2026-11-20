import type { Metadata } from "next";
import Link from "next/link";

import { ROLE_LABEL, ROLE_TITLE, SITE_STATE_LABEL, VERDICT_BADGE, VERDICT_LABEL } from "@/components/provider_stats/labels";
import { PageShell, Pagination } from "@/components/provider_stats/PageShell";
import { providerRoles } from "@/lib/provider_stats/role";
import { routeVerdicts } from "@/lib/provider_stats/route_outcome";
import { getReportFeed, pageOf, reportFilterOf, siteStateOf, type ReportFeedEntry, type ReportFilter } from "@/lib/provider_stats/views";
import { cn } from "@/lib/util/cn";
import { utcDate } from "@/lib/util/date_time";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "All phishing reports",
	description: "Every phishing report Phishing Support sent: the reported site, every provider it went to, how each answered, and whether the site is down.",
	alternates: { canonical: "/reports" },
};

const SITE_FILTER = { down: "Site down", online: "Site online", unchecked: "Not checked" } as const;

function query(filter: ReportFilter, page = 1): string {
	const params = new URLSearchParams(Object.entries(filter).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
	if (page > 1) params.set("page", String(page));
	const text = params.toString();
	return text ? `/reports?${text}` : "/reports";
}

function Select({ name, value, options, all, label }: { name: string; value: string | undefined; options: ReadonlyArray<[string, string]>; all: string; label: string }) {
	return (
		<select name={name} aria-label={label} defaultValue={value ?? ""} className="h-9 max-w-[15rem] rounded-md border bg-background px-2 text-sm">
			<option value="">{all}</option>
			{options.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
		</select>
	);
}

function SiteState({ entry }: { entry: ReportFeedEntry }) {
	const state = siteStateOf(entry.routes);
	const latest = entry.routes.find((route) => route.takedown)?.takedown?.state;
	return <span className={cn("text-xs", state === "down" ? "text-emerald-700" : state === "online" ? "text-red-700" : "text-muted-foreground")}>{latest ? SITE_STATE_LABEL[latest] : "Not checked"}</span>;
}

function Entry({ entry }: { entry: ReportFeedEntry }) {
	const href = entry.submissionId ? `/submissions/${entry.submissionId}` : `/reports/${entry.reportId}`;
	const delivered = entry.routes.filter((route) => route.outcome.verdict !== "not_delivered" && route.outcome.verdict !== "pending");
	return (
		<li className="grid gap-2 px-4 py-3 sm:grid-cols-[6.5rem_minmax(0,1fr)_9rem] sm:items-start hover:bg-muted/20">
			<span className="text-sm tabular-nums text-muted-foreground">{utcDate(entry.createdAt)}</span>
			<div className="min-w-0 space-y-2">
				<Link href={href} className="block truncate font-mono text-sm hover:underline">{entry.targets.join(", ") || `Report ${entry.reportId}`}</Link>
				{entry.routes.length ? (
					<ul className="flex flex-wrap gap-1.5">
						{entry.routes.map((route) => (
							<li key={String(route.routeId)}>
								<Link href={`/providers/${route.organisation.slug}`} title={`${route.organisation.name} (${ROLE_LABEL[route.role]}): ${VERDICT_LABEL[route.outcome.verdict]}`} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs hover:opacity-80", VERDICT_BADGE[route.outcome.verdict])}>
									{route.organisation.name}
									<span className="opacity-70">· {VERDICT_LABEL[route.outcome.verdict]}</span>
								</Link>
							</li>
						))}
					</ul>
				) : <p className="text-xs text-muted-foreground">No provider route: {entry.status.replaceAll("_", " ")}</p>}
			</div>
			<div className="flex flex-col gap-0.5 sm:items-end">
				<SiteState entry={entry} />
				{entry.routes.length ? <span className="text-xs text-muted-foreground">{delivered.length} of {entry.routes.length} filed</span> : null}
			</div>
		</li>
	);
}

/** Every report, newest first, each with every provider it went to and how that provider answered. */
export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const params = await searchParams;
	const filter = reportFilterOf(params);
	const feed = await getReportFeed(filter, pageOf(params.page));
	const filtered = Object.keys(filter).length > 0;
	return (
		<PageShell current="/reports">
			<header className="space-y-3">
				<h1 className="text-3xl font-bold tracking-tight sm:text-4xl">All reports</h1>
				<p className="max-w-3xl text-pretty text-lg text-muted-foreground">Every phishing report, the providers it went to, how each answered, and whether the site is down now. Open a report for the full correspondence.</p>
			</header>
			<form action="/reports" className="flex flex-wrap items-center gap-2">
				<Select name="provider" label="Provider" value={filter.provider} all="Any provider" options={feed.organisations.map((organisation) => [organisation.slug, organisation.name])} />
				<Select name="role" label="Role" value={filter.role} all="Any role" options={providerRoles.map((role) => [role, ROLE_TITLE[role]])} />
				<Select name="verdict" label="Answer" value={filter.verdict} all="Any answer" options={routeVerdicts.map((verdict) => [verdict, VERDICT_LABEL[verdict]])} />
				<Select name="site" label="Site state" value={filter.site} all="Any site state" options={Object.entries(SITE_FILTER)} />
				<button type="submit" className="h-9 rounded-md bg-foreground px-3 text-sm text-background">Filter</button>
				{filtered ? <Link href="/reports" className="text-sm text-muted-foreground hover:text-foreground">Clear</Link> : null}
				<span className="ml-auto text-sm tabular-nums text-muted-foreground">{feed.total} {feed.total === 1 ? "report" : "reports"}</span>
			</form>
			{filter.role || filter.verdict ? <p className="-mt-6 text-xs text-muted-foreground">A report is listed when one of its providers matches every filter at once.</p> : null}
			{feed.entries.length ? (
				<ul className="divide-y rounded-xl border">{feed.entries.map((entry) => <Entry key={String(entry.reportId)} entry={entry} />)}</ul>
			) : <p className="rounded-xl border px-4 py-10 text-center text-muted-foreground">No report matches.</p>}
			<Pagination page={feed.page} pageCount={feed.pageCount} href={(page) => query(filter, page)} />
		</PageShell>
	);
}
