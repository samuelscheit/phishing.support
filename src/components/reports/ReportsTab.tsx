"use client";

import Link from "next/link";
import { ChevronRight, Download } from "lucide-react";

import { ROLE_LABEL } from "@/components/provider_stats/labels";
import { Card } from "@/components/ui/card";
import type { WebsiteSubmissionData } from "@/lib/db/schema";
import type { SubmissionReport } from "@/lib/submissions/abuse_details";
import { nextStep, rankedRoutes, routeBuckets, shortUtc, subjectLabel, takedownSummary, type RouteEntry, type TakedownSummary } from "@/lib/submissions/report_view";
import { cn } from "@/lib/util/cn";
import { RouteTimeline } from "./RouteTimeline";
import { BUCKET_STYLE, ProviderAvatar, StandingPill, Steps } from "./standing";

type Investigation = NonNullable<WebsiteSubmissionData["investigation"]>;

const capitalised = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "10 minutes", "2 hours", "3 days" after the report. */
function elapsed(from: Date | string, to: Date | string): string {
	const minutes = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000));
	if (minutes < 90) return plural(minutes, "minute");
	if (minutes < 48 * 60) return plural(Math.round(minutes / 60), "hour");
	return plural(Math.round(minutes / 1440), "day");
}

function targetName(report: SubmissionReport): string {
	return report.funnelParty?.site ?? report.target ?? `Report ${report.id}`;
}

function CaseLinks({ ids }: { ids: string[] }) {
	return ids.map((id, index) => (
		<span key={id}>{index > 0 ? ", " : null}<Link href={`/submissions/${id}`} className="text-primary hover:underline">case {id}</Link></span>
	));
}

/** The headline: the strongest outcome any provider reached, said plainly. */
function Headline({ summary, reports }: { summary: TakedownSummary; reports: readonly SubmissionReport[] }) {
	const best = summary.best;
	if (!best) return null;
	const { standing, route, report } = best;
	const open = summary.counts.received + summary.counts.unconfirmed + summary.counts.waiting;
	if (summary.moved) {
		const { move, text } = summary.moved;
		const bypassed = rankedRoutes(reports).find((entry) => entry.report === summary.moved!.report && entry.standing.bucket === "bypassed");
		return (
			<>
				<h3 className="text-lg font-semibold tracking-tight [overflow-wrap:anywhere]">
					<span className="text-orange-700">{text}</span> <span className="font-normal text-muted-foreground">· {targetName(summary.moved.report)}</span>
				</h3>
				<p className="text-sm text-muted-foreground">
					{bypassed ? `${bypassed.route.organisation} had acted on it; the site left ${move.from.name} ${elapsed(summary.moved.report.createdAt, move.at)} after the report.` : `The site left ${move.from.name} ${elapsed(summary.moved.report.createdAt, move.at)} after the report.`}
					{open ? ` ${plural(open, "report")} ${open === 1 ? "is" : "are"} still open.` : null}
				</p>
			</>
		);
	}
	if (standing.bucket === "action_taken") {
		return (
			<>
				<h3 className="text-lg font-semibold tracking-tight [overflow-wrap:anywhere]">
					<span className="text-emerald-700">{standing.label}</span> by {route.organisation} <span className="font-normal text-muted-foreground">· {targetName(report)}</span>
				</h3>
				<p className="text-sm text-muted-foreground">
					{standing.at ? `At ${shortUtc(standing.at)} UTC, ${elapsed(report.createdAt, standing.at)} after the report.` : null}
					{open ? ` ${plural(open, "other report")} ${open === 1 ? "is" : "are"} still open.` : null}
				</p>
			</>
		);
	}
	const text = standing.bucket === "bypassed" ? "A provider acted, and the site moved on"
		: standing.bucket === "received" ? `Received by ${plural(summary.counts.received, "provider")}, no decision yet`
		: standing.bucket === "declined" ? "No provider has acted yet"
		: standing.bucket === "unconfirmed" || standing.bucket === "waiting" ? "Reports sent, waiting for answers"
		: "No report has reached a provider";
	return (
		<>
			<h3 className="text-lg font-semibold tracking-tight">{text}</h3>
			{summary.counts.declined ? <p className="text-sm text-muted-foreground">{plural(summary.counts.declined, "provider")} found no threat or declined.</p> : null}
		</>
	);
}

/** What went with the reports: the payloads downloaded and checked before any provider was contacted, and the evidence files. */
function Evidence({ reports, investigation }: { reports: readonly SubmissionReport[]; investigation?: Investigation }) {
	const files = new Map<string, { reportId: bigint; id: bigint; name: string }>();
	for (const report of reports) for (const artifact of report.artifacts) {
		if (artifact.kind === "user_evidence_original" && !files.has(artifact.name)) files.set(artifact.name, { reportId: report.id, id: artifact.id, name: artifact.name });
	}
	const payloads = investigation?.payloads ?? [];
	if (!files.size && !payloads.length && !investigation) return null;
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t bg-muted/30 px-4 py-3 text-xs text-muted-foreground sm:px-5">
			<span className="font-medium text-foreground">Evidence sent</span>
			{investigation && investigation.status !== "completed" ? <span>Pre-report investigation {investigation.status === "failed" ? "could not finish; the reports went with the evidence already captured" : "running"}</span> : null}
			{payloads.map((payload) => (
				<span key={payload.url} className="inline-flex flex-wrap items-center gap-x-2 gap-y-1" title={payload.url}>
					{payload.sha256 ? <span>Payload <span className="font-mono">{payload.sha256.slice(0, 8)}…{payload.sha256.slice(-5)}</span>{payload.sizeBytes ? ` · ${Math.round(payload.sizeBytes / 1024)} KB` : ""}</span> : <span>Payload not downloaded{payload.error ? `: ${payload.error}` : ""}</span>}
					{payload.verdict ? <span className="rounded-full border border-red-200 bg-red-50 px-1.5 py-px text-red-700">{payload.verdict.replace(/^virustotal:/i, "VirusTotal:")}</span> : null}
				</span>
			))}
			{[...files.values()].map((file) => (
				<a key={file.name} href={`/api/reports/${file.reportId}/artifacts/${file.id}`} className="inline-flex items-center gap-1 text-primary hover:underline">
					<Download className="h-3 w-3" />{file.name}
				</a>
			))}
		</div>
	);
}

/** The case's takedown status: the strongest outcome, the reports by standing, who they reached, and what went with them. */
function Summary({ reports, caseId, investigation }: { reports: readonly SubmissionReport[]; caseId?: string; investigation?: Investigation }) {
	const summary = takedownSummary(reports, caseId);
	const present = routeBuckets.filter((bucket) => summary.counts[bucket] > 0);
	return (
		<Card className="overflow-hidden">
			<div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
				<div className="min-w-0 flex-1 space-y-1">
					<div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Takedown status</div>
					<Headline summary={summary} reports={reports} />
					<div className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={present.map((bucket) => `${summary.counts[bucket]} ${BUCKET_STYLE[bucket].legend}`).join(", ")}>
						{present.map((bucket) => <span key={bucket} className={BUCKET_STYLE[bucket].fill} style={{ flexGrow: summary.counts[bucket] }} />)}
					</div>
					<ul className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground">
						{present.map((bucket) => (
							<li key={bucket} className="inline-flex items-center gap-1.5">
								<span className={cn("h-2 w-2 rounded-sm", BUCKET_STYLE[bucket].fill)} aria-hidden />
								<span className="font-semibold text-foreground">{summary.counts[bucket]}</span> {BUCKET_STYLE[bucket].legend}
							</li>
						))}
					</ul>
				</div>
				<div className="flex shrink-0 flex-col items-start gap-1.5 text-xs text-muted-foreground sm:items-end sm:text-right">
					{summary.best ? <StandingPill bucket={summary.best.standing.bucket}>{summary.best.standing.label}</StandingPill> : null}
					<span>{plural(summary.total, "report")} · {plural(summary.targets, "target")} · {plural(summary.providers, "provider")}</span>
					{summary.alsoCovers.length ? <span>Also covers <CaseLinks ids={summary.alsoCovers} /></span> : null}
					{summary.coveredBy.length ? <span>Reported for <CaseLinks ids={summary.coveredBy} /></span> : null}
				</div>
			</div>
			<Evidence reports={reports} investigation={investigation} />
		</Card>
	);
}

/** One provider's report: who, its role and channel, Sent → Received → Decision, its standing in plain words and its key sentence; expands to the timeline. */
function RouteRow({ entry }: { entry: RouteEntry }) {
	const { route, report, standing } = entry;
	const next = nextStep(route, standing, report.createdAt);
	return (
		<details id={`route-${route.id}`} className="group scroll-mt-24 border-t first:border-t-0 target:bg-amber-50/40">
			<summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2.5 px-4 py-3 hover:bg-muted/30 [&::-webkit-details-marker]:hidden @2xl:grid-cols-[minmax(0,13rem)_7.5rem_minmax(0,1fr)_auto]">
				<div className="flex min-w-0 items-center gap-2.5">
					<ProviderAvatar name={route.organisation} />
					<div className="min-w-0">
						<div className="truncate text-sm font-medium">{route.organisation}</div>
						<div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
							{capitalised(ROLE_LABEL[route.role])} · {route.channel}{route.namedBy ? ` · named by ${route.namedBy.organisation}` : ""}
						</div>
					</div>
				</div>
				<div className="col-start-2 row-start-1 flex items-center gap-2 @2xl:col-start-4">
					{standing.at ? <time dateTime={new Date(standing.at).toISOString()} className="text-xs tabular-nums text-muted-foreground">{shortUtc(standing.at, report.createdAt)}</time> : null}
					<ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
				</div>
				<div className="col-span-2 @2xl:col-span-1 @2xl:col-start-2 @2xl:row-start-1">
					<Steps steps={standing.steps} />
				</div>
				<div className="col-span-2 min-w-0 space-y-0.5 @2xl:col-span-1 @2xl:col-start-3 @2xl:row-start-1">
					<StandingPill bucket={standing.bucket}>{standing.label}</StandingPill>
					{standing.line ? <p className="line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]" title={standing.line}>{standing.quoted ? `“${standing.line}”` : standing.line}</p> : null}
				</div>
				{next ? <p className="col-span-2 text-xs text-muted-foreground @2xl:col-span-3 @2xl:col-start-2"><span className="font-medium text-foreground">Next:</span> {next}</p> : null}
			</summary>
			<div className="border-t bg-muted/20 px-4 py-4 @2xl:pl-[3.75rem]">
				<RouteTimeline route={route} report={report} />
			</div>
		</details>
	);
}

/** A route another route's answer led to comes right after it: Cloudflare, then the host it named. */
function withNextHops(entries: RouteEntry[]): RouteEntry[] {
	const named = (entry: RouteEntry) => entry.route.namedBy !== null && entries.some((other) => other.route.id === entry.route.namedBy!.routeId);
	const ordered: RouteEntry[] = [];
	const place = (entry: RouteEntry) => {
		ordered.push(entry);
		for (const hop of entries.filter((other) => other.route.namedBy?.routeId === entry.route.id)) place(hop);
	};
	for (const entry of entries.filter((candidate) => !named(candidate))) place(entry);
	return ordered;
}

/** One reported target: its role for the case and every provider its reports went to. */
function TargetGroup({ reports, caseId }: { reports: SubmissionReport[]; caseId?: string }) {
	const [first] = reports;
	const entries = withNextHops(rankedRoutes(reports));
	const owners = [...new Set(reports.filter((report) => caseId !== undefined && report.submissionId !== null && String(report.submissionId) !== caseId).map((report) => String(report.submissionId)))];
	const url = first!.subject === "payload_host" ? first!.routes[0]?.observedUrls[0] : undefined;
	return (
		<section className="space-y-2">
			<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-0.5">
				<h3 className="flex min-w-0 flex-wrap items-center gap-2 text-base font-semibold">
					<span className="break-all">{targetName(first!)}</span>
					<span className="rounded-md border bg-background px-1.5 py-px text-[11px] font-medium text-muted-foreground">{subjectLabel(first!)}</span>
				</h3>
				<span className="text-xs text-muted-foreground">
					{plural(entries.length, "report")}
					{url ? <> · serves <span className="break-all font-mono">{new URL(url).pathname}</span></> : null}
					{owners.length ? <> · reported for <CaseLinks ids={owners} /></> : null}
				</span>
			</div>
			<Card className="@container overflow-hidden">
				{entries.length ? entries.map((entry) => <RouteRow key={String(entry.route.id)} entry={entry} />) : <p className="px-4 py-3 text-sm text-muted-foreground">No provider has been contacted yet.</p>}
			</Card>
		</section>
	);
}

/**
 * Reports tab: the takedown status of the whole case first, then each
 * reported target (the site, a payload host it led to) with one row per
 * provider. Read-only: a case page is public.
 */
export function SubmissionReports({ reports, caseId, investigation }: { reports: SubmissionReport[]; caseId?: string; investigation?: Investigation }) {
	if (reports.length === 0) return <div className="py-10 text-center text-muted-foreground">No reports yet.</div>;
	const groups = new Map<string, SubmissionReport[]>();
	for (const report of reports) groups.set(targetName(report), [...(groups.get(targetName(report)) ?? []), report]);
	return (
		<div className="space-y-6">
			<Summary reports={reports} caseId={caseId} investigation={investigation} />
			{[...groups].map(([name, group]) => <TargetGroup key={name} reports={group} caseId={caseId} />)}
		</div>
	);
}
