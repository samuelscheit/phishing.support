import Link from "next/link";
import { Fragment, useState, type ReactNode } from "react";
import { RotateCcw, ShieldAlert } from "lucide-react";
import { instructionsDraft, ReporterInstructionsFields, ReporterInstructionsView } from "@/components/ReporterInstructionsFields";
import type { ReporterInstructions } from "@/lib/submissions/instructions";
import { Button } from "@/components/ui/button";
import { describeDataEntryField } from "@/lib/website/types";
import { findingLabel, routeLabel, type ConfirmedSite, type DeceptiveRoute } from "./helpers";
import { hostOf } from "@/lib/network/url";
import { cn } from "@/lib/util/cn";
import type { SubmissionReport } from "@/lib/submissions/details";
import { FunnelVerdict } from "./FunnelVerdict";

const PANEL = "rounded-lg border bg-muted/30 p-4";

/** The routes a finding was made on, each a button that shows that route. */
function RouteTags({ routes, onShowRoute }: { routes: readonly number[]; onShowRoute: (route: number) => void }): ReactNode {
	return routes.map((route, index) => (
		<Fragment key={route}>
			{index > 0 ? ", " : null}
			<button type="button" onClick={() => onShowRoute(route)} className="font-medium text-primary hover:underline">{routeLabel(route)}</button>
		</Fragment>
	));
}

/**
 * One confirmed site's verdict with its evidence; the site is named when the
 * case has several or it is not the submitted one, and the routes it showed on
 * (`onShowRoute`) are named when the link rotated.
 */
function SiteVerdict({ confirmed: { site, assessment, routes }, named, onShowRoute }: { confirmed: ConfirmedSite; named: boolean; onShowRoute: ((route: number) => void) | undefined }) {
	return (
		<div>
			<div className="flex items-center gap-2 text-sm font-semibold text-destructive">
				<ShieldAlert className="h-4 w-4 shrink-0" />
				{(assessment ? findingLabel(assessment) : "Phishing confirmed")}
			</div>
			{named || onShowRoute ? (
				<div className="mt-1 text-xs">
					{onShowRoute ? <RouteTags routes={routes} onShowRoute={onShowRoute} /> : null}
					{onShowRoute && named ? <span className="text-muted-foreground"> · </span> : null}
					{named ? <span className="break-all font-mono">{site}</span> : null}
				</div>
			) : null}
			{assessment.impersonatedBrand ? (
				<p className="mt-2 text-sm">
					Impersonates <span className="font-medium">{assessment.impersonatedBrand.name}</span>
					<span className="text-muted-foreground"> · official site </span>
					<span className="text-muted-foreground">{hostOf(assessment.impersonatedBrand.officialUrl)}</span>
				</p>
			) : null}
			{assessment.evidenceQuote ? (
				<>
					<div className="mt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Evidence</div>
					<blockquote className="mt-1 border-l-2 pl-2 text-xs text-muted-foreground">“{assessment.evidenceQuote}”</blockquote>
				</>
			) : null}
			{assessment.collectionFields?.length ? (
				<p className="mt-2 text-xs text-muted-foreground">Asks for {assessment.collectionFields.map((field) => `“${describeDataEntryField(field)}”`).join(", ")}</p>
			) : null}
		</div>
	);
}

/**
 * The confirmed verdicts of every route of the case: each reported site once,
 * however many routes showed it, then each route judged a deceptive funnel,
 * with their evidence and the way to the reports tab. With several routes each
 * verdict names its routes, which show that route when clicked.
 */
export function VerdictPanel({ sites, funnels, routeCount, reports, caseId, submittedSite, reportCount, joinedCases, info, onShowReports, onShowRoute }: {
	sites: readonly ConfirmedSite[];
	/** The routes judged deceptive affiliate funnels. */
	funnels: readonly DeceptiveRoute[];
	routeCount: number;
	reports: readonly SubmissionReport[];
	caseId: string;
	submittedSite: string | null;
	reportCount: number;
	/** The cases whose open reports cover this case's sites, when it filed none of its own. */
	joinedCases: string[];
	info: string | null | undefined;
	onShowReports: () => void;
	onShowRoute: (route: number) => void;
}) {
	// A single route needs no naming: every finding is on it.
	const showRoute = routeCount > 1 ? onShowRoute : undefined;
	return (
		<section className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
			{sites.map((confirmed, index) => (
				<div key={confirmed.site} className={cn(index > 0 && "mt-4 border-t border-destructive/15 pt-4")}>
					<SiteVerdict confirmed={confirmed} named={sites.length > 1 || confirmed.site !== submittedSite} onShowRoute={showRoute} />
				</div>
			))}
			{funnels.map(({ route, funnel }, index) => (
				<div key={route} className={cn((sites.length > 0 || index > 0) && "mt-4 border-t border-destructive/15 pt-4")}>
					<FunnelVerdict funnel={funnel} reports={reports} caseId={caseId} context={showRoute ? <RouteTags routes={[route]} onShowRoute={showRoute} /> : undefined} />
				</div>
			))}
			{/* A reported case that recorded neither (an email, or a case from before its verdicts were kept per site). */}
			{!sites.length && !funnels.length ? (
				<div className="flex items-center gap-2 text-sm font-semibold text-destructive">
					<ShieldAlert className="h-4 w-4" />
					Phishing confirmed
				</div>
			) : null}
			{/* A confirmed site with no report: its case was confirmed from evidence collected elsewhere, after the site was gone; its info says why. */}
			{reportCount ? (
				<div className="mt-3 flex items-center justify-between gap-2 border-t border-destructive/15 pt-3 text-xs">
					<span className="text-muted-foreground">{joinedCases.length ? `Covered by the open report${reportCount === 1 ? "" : "s"} of case ${joinedCases.join(", ")}.` : "Being reported to the responsible providers."}</span>
					<button type="button" onClick={onShowReports} className="shrink-0 font-medium text-primary hover:underline">{reportCount} report{reportCount === 1 ? "" : "s"} →</button>
				</div>
			) : (
				<p className="mt-3 border-t border-destructive/15 pt-3 text-xs text-muted-foreground whitespace-pre-wrap">{info || "No report was sent."}</p>
			)}
		</section>
	);
}

/**
 * The "Analyze again" action of a case: offered (`offered`) only while the case can take a retry.
 * A website case's (`instructions` set) lets the reporter's instructions be edited for the new run.
 */
export type AnalyzeAgain = { offered: boolean; running: boolean; error: string | null; hint: string; label?: string; instructions?: ReporterInstructions; onStart: (instructions?: ReturnType<typeof instructionsDraft>) => void };

/** The reporter's instructions of a website case, as submitted. */
export function ReporterInstructionsPanel({ instructions }: { instructions: ReporterInstructions }) {
	return (
		<div className={PANEL}>
			<div className="mb-2 text-xs font-semibold text-muted-foreground">Reporter&apos;s instructions</div>
			<ReporterInstructionsView instructions={instructions} />
		</div>
	);
}

function AnalyzeAgainAction({ analyzeAgain }: { analyzeAgain: AnalyzeAgain }) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(() => instructionsDraft(analyzeAgain.instructions));
	return (
		<div className="mt-3 space-y-3">
			{editing ? <ReporterInstructionsFields value={draft} onChange={setDraft} disabled={analyzeAgain.running} /> : null}
			<div className="flex flex-wrap items-center gap-3">
				<Button type="button" variant="outline" size="sm" disabled={analyzeAgain.running} onClick={() => analyzeAgain.onStart(editing ? draft : undefined)}>
					<RotateCcw className="h-3.5 w-3.5" />
					{analyzeAgain.running ? "Starting analysis…" : analyzeAgain.label ?? "Analyze again"}
				</Button>
				{analyzeAgain.instructions && !editing ? (
					<Button type="button" variant="ghost" size="sm" disabled={analyzeAgain.running} onClick={() => setEditing(true)}>
						Edit instructions
					</Button>
				) : null}
				<span className="text-xs text-muted-foreground">{analyzeAgain.hint}</span>
			</div>
		</div>
	);
}

/**
 * Why a case ended without a report, a verdict of nothing reportable or a
 * failed analysis, with the way to have it analyzed again.
 */
export function OutcomePanel({ title, info, related, analyzeAgain }: { title: string; info: string; related?: { href: string; label: string }; analyzeAgain: AnalyzeAgain }) {
	return (
		<div className={PANEL}>
			<div className="text-xs font-semibold text-muted-foreground">{title}</div>
			<div className="mt-1 text-sm whitespace-pre-wrap">{info}</div>
			{related ? <Link href={related.href} className="mt-2 inline-block text-sm font-medium text-primary hover:underline">{related.label}</Link> : null}
			{analyzeAgain.offered ? <AnalyzeAgainAction analyzeAgain={analyzeAgain} /> : null}
			{analyzeAgain.error ? <div className="mt-2 text-sm text-destructive">{analyzeAgain.error}</div> : null}
		</div>
	);
}
