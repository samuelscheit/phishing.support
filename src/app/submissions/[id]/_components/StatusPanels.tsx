import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { describeDataEntryField } from "@/lib/website/types";
import { verdictLabelOf, type SiteAssessment } from "./helpers";
import { hostOf } from "@/lib/network/url";
import { cn } from "@/lib/util/cn";
import type { DeceptiveFunnelFinding } from "@/lib/abuse/funnel/classification";
import type { SubmissionReport } from "@/lib/submissions/details";
import type { WebsiteFunnel } from "@/lib/website/types";
import { FunnelVerdict } from "./FunnelVerdict";

const PANEL = "rounded-lg border bg-muted/30 p-4";

/** One confirmed site's verdict with its evidence; the site is named when the chain has several or it is not the submitted one. */
function SiteVerdict({ site, assessment, named }: { site: string; assessment: SiteAssessment; named: boolean }) {
	return (
		<div>
			<div className="flex items-center gap-2 text-sm font-semibold text-destructive">
				<ShieldAlert className="h-4 w-4 shrink-0" />
				{verdictLabelOf(assessment) ?? "Phishing confirmed"}
			</div>
			{named ? <div className="mt-1 font-mono text-xs">{site}</div> : null}
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

/** The confirmed verdict of each reported site of the chain and of the funnel it is, with their evidence and the way to the reports tab. */
export function VerdictPanel({ sites, funnel, reports, caseId, submittedSite, reportCount, joinedCases, info, onShowReports }: {
	sites: Array<{ site: string; assessment: SiteAssessment }>;
	/** The chain as a deceptive affiliate funnel, when it was judged one. */
	funnel?: WebsiteFunnel & { verdict: DeceptiveFunnelFinding };
	reports: readonly SubmissionReport[];
	caseId: string;
	submittedSite: string | null;
	reportCount: number;
	/** The cases whose open reports cover this case's sites, when it filed none of its own. */
	joinedCases: string[];
	info: string | null | undefined;
	onShowReports: () => void;
}) {
	return (
		<section className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
			{sites.map(({ site, assessment }, index) => (
				<div key={site} className={cn(index > 0 && "mt-4 border-t border-destructive/15 pt-4")}>
					<SiteVerdict site={site} assessment={assessment} named={sites.length > 1 || site !== submittedSite} />
				</div>
			))}
			{funnel ? (
				<div className={cn(sites.length > 0 && "mt-4 border-t border-destructive/15 pt-4")}>
					<FunnelVerdict funnel={funnel} reports={reports} caseId={caseId} />
				</div>
			) : null}
			{/* A reported case that recorded neither (an email, or a case from before its verdicts were kept per site). */}
			{!sites.length && !funnel ? (
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

export function NotReportedPanel({ info }: { info: string | null | undefined }) {
	return (
		<div className={PANEL}>
			<div className="text-xs font-semibold text-muted-foreground">Not reported</div>
			<div className="mt-1 text-sm whitespace-pre-wrap">{info}</div>
		</div>
	);
}

export function FailedPanel({ info, canRetry, retrying, retryError, retryHint, onRetry }: { info: string | null | undefined; canRetry: boolean; retrying: boolean; retryError: string | null; retryHint: string; onRetry: () => void }) {
	return (
		<div className={PANEL}>
			<div className="text-xs font-semibold text-muted-foreground">Failure reason</div>
			<div className="mt-1 text-sm whitespace-pre-wrap">{info || "The analysis did not complete."}</div>
			{canRetry ? (
				<div className="mt-3 flex flex-wrap items-center gap-3">
					<Button type="button" variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
						{retrying ? "Retrying analysis…" : "Retry analysis"}
					</Button>
					<span className="text-xs text-muted-foreground">{retryHint}</span>
				</div>
			) : null}
			{retryError ? <div className="mt-2 text-sm text-destructive">{retryError}</div> : null}
		</div>
	);
}
