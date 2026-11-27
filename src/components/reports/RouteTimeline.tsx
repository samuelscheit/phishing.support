import type { ReactNode } from "react";
import { Download } from "lucide-react";

import type { ProviderRole } from "@/lib/provider_stats/role";
import type { SubmissionReport, SubmissionReportRoute } from "@/lib/submissions/abuse_details";
import { routeTimeline, shortUtc, type TimelineEntry } from "@/lib/submissions/report_view";
import { cn } from "@/lib/util/cn";

/** A role as the noun a sentence names a company by: "the hosting provider Cloudflare named". */
const ROLE_NOUN: Record<ProviderRole, string> = {
	registrar: "registrar",
	host: "hosting provider",
	cdn: "CDN",
	blocklist: "blocklist",
	email: "email service",
	platform: "platform",
	authority: "authority",
	other: "contact",
};

/** A folded block of text: what we sent, a provider's full email, our report as it quoted it. */
function Fold({ label, children }: { label: string; children: ReactNode }) {
	return (
		<details className="group/fold">
			<summary className="cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
				<span className="inline-block transition-transform group-open/fold:rotate-90" aria-hidden>▸</span> {label}
			</summary>
			<div className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-3 text-xs leading-relaxed [overflow-wrap:anywhere]">{children}</div>
		</details>
	);
}

function Node({ tone }: { tone: "ours" | "good" | "bad" | "plain" | "small" }) {
	return (
		<span className={cn(
			"absolute left-0 rounded-full",
			tone === "small" ? "left-[3px] top-[7px] h-[7px] w-[7px] bg-zinc-400" : "top-[5px] h-[13px] w-[13px] border-2 bg-background",
			tone === "ours" && "border-blue-600",
			tone === "good" && "border-emerald-600 bg-emerald-600",
			tone === "bad" && "border-red-500 bg-red-500",
			tone === "plain" && "border-zinc-400",
		)} aria-hidden />
	);
}

function Head({ children, at, reference }: { children: ReactNode; at?: Date; reference: Date | string }) {
	return (
		<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
			<span className="min-w-0">{children}</span>
			{at ? <time dateTime={at.toISOString()} className="shrink-0 text-xs tabular-nums text-muted-foreground">{shortUtc(at, reference)}</time> : null}
		</div>
	);
}

function Entry({ entry, route, reportId, artifacts, reference }: { entry: TimelineEntry; route: SubmissionReportRoute; reportId: string; artifacts: SubmissionReport["artifacts"]; reference: Date | string }) {
	switch (entry.kind) {
		case "reported":
			return (
				<>
					<Node tone="ours" />
					<Head at={entry.at} reference={reference}>
						<span className="font-medium">{entry.title}</span>
						{entry.receipt ? <span className="text-muted-foreground"> · receipt <span className="font-mono text-xs">{entry.receipt}</span></span> : null}
					</Head>
					<div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
						{entry.sent ? <Fold label="What we sent">{entry.sent}</Fold> : null}
						{entry.confirmation ? <Fold label={`${route.organisation}'s confirmation`}>{entry.confirmation}</Fold> : null}
					</div>
				</>
			);
		case "not_sent":
			return (
				<>
					<Node tone="bad" />
					<Head at={entry.at} reference={reference}><span className="font-medium">{entry.title}</span></Head>
					{entry.draft ? <div className="mt-1"><Fold label="What we would have sent">{entry.draft}</Fold></div> : null}
				</>
			);
		case "states":
			return (
				<>
					<Node tone="small" />
					<p className="text-sm text-muted-foreground">
						Status{" "}
						{entry.states.map((state, index) => (
							<span key={`${state.state}-${state.at.getTime()}`}>
								{index > 0 ? " → " : null}
								<span className="rounded-full border bg-muted/50 px-1.5 py-px text-xs text-foreground">{state.state}{state.detail ? ` (${state.detail.replaceAll("_", " ")})` : ""}</span>{" "}
								<span className="tabular-nums">{shortUtc(state.at, reference)}</span>
							</span>
						))}
					</p>
				</>
			);
		case "message": {
			const raw = entry.rawArtifactId !== null ? artifacts.find((artifact) => String(artifact.id) === String(entry.rawArtifactId)) : undefined;
			return (
				<>
					<Node tone={!entry.inbound ? "ours" : entry.failed || entry.decision === "declined" || entry.decision === "no_threat" ? "bad" : entry.decision ? "good" : "plain"} />
					<Head at={entry.at} reference={reference}><span className="font-medium">{entry.title}</span></Head>
					<div className={cn("mt-1.5 rounded-lg border bg-background p-3 text-sm", entry.failed && "border-red-200 bg-red-50/50")}>
						{entry.subject ? <div className="mb-1 break-words font-medium [overflow-wrap:anywhere]">{entry.subject}</div> : null}
						{entry.sentence ? (
							<p className="break-words [overflow-wrap:anywhere]">
								{entry.highlight ? <mark className="rounded bg-emerald-100 px-0.5 text-emerald-950">{entry.sentence}</mark> : entry.sentence}
							</p>
						) : null}
						<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
							{entry.text ? <Fold label={entry.inbound ? "Full email" : "What we wrote"}>{entry.text.main}</Fold> : null}
							{entry.text?.quoted ? <Fold label="Our report, quoted">{entry.text.quoted}</Fold> : null}
							{raw ? (
								<a href={`/api/reports/${reportId}/artifacts/${raw.id}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
									<Download className="h-3 w-3" /> Original (.eml)
								</a>
							) : null}
						</div>
					</div>
				</>
			);
		}
		case "not_answered":
			return (
				<>
					<Node tone="plain" />
					<Head at={entry.at} reference={reference}><span className="font-medium">Decision “{entry.decision.replaceAll("_", " ")}” left unanswered</span></Head>
					<p className="mt-1 text-sm text-muted-foreground">{entry.explanation}</p>
				</>
			);
		case "next_hop":
			return (
				<>
					<Node tone="ours" />
					<Head at={entry.at} reference={reference}>
						<span className="font-medium">Next hop</span>
						<span className="text-muted-foreground"> · reported to <a href={`#route-${entry.routeId}`} className="text-primary hover:underline">{entry.organisation}</a>, the {ROLE_NOUN[entry.role]} {route.organisation} named</span>
					</Head>
				</>
			);
	}
}

/**
 * One route's history, oldest first: what we sent, the provider's status
 * changes on one line, its messages by their key sentence with the full text
 * folded, and the reports its answer led to.
 */
export function RouteTimeline({ route, report }: { route: SubmissionReportRoute; report: SubmissionReport }) {
	const reference = report.createdAt;
	return (
		<ol className="relative space-y-4 before:absolute before:bottom-2 before:left-[6px] before:top-2 before:w-px before:bg-border">
			{routeTimeline(route, report.routes).map((entry, index) => (
				<li key={index} className="relative min-w-0 pl-6">
					<Entry entry={entry} route={route} reportId={String(report.id)} artifacts={report.artifacts} reference={reference} />
				</li>
			))}
		</ol>
	);
}
