import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { describeDataEntryField } from "@/lib/website/types";
import { type SiteAssessment } from "./helpers";
import { hostOf } from "@/lib/network/url";

const PANEL = "rounded-lg border bg-muted/30 p-4";

/** The confirmed-phishing verdict with its evidence and the way to the reports tab. */
export function VerdictPanel({ verdictLabel, assessment, reportCount, info, onShowReports }: { verdictLabel: string | undefined; assessment: SiteAssessment | undefined; reportCount: number; info: string | null | undefined; onShowReports: () => void }) {
	return (
		<section className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
			<div className="flex items-center gap-2 text-sm font-semibold text-destructive">
				<ShieldAlert className="h-4 w-4" />
				{verdictLabel ?? "Phishing confirmed"}
			</div>
			{assessment?.impersonatedBrand ? (
				<p className="mt-2 text-sm">
					Impersonates <span className="font-medium">{assessment.impersonatedBrand.name}</span>
					<span className="text-muted-foreground"> · official site </span>
					<span className="text-muted-foreground">{hostOf(assessment.impersonatedBrand.officialUrl)}</span>
				</p>
			) : null}
			{assessment?.evidenceQuote ? (
				<>
					<div className="mt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Evidence</div>
					<blockquote className="mt-1 border-l-2 pl-2 text-xs text-muted-foreground">“{assessment.evidenceQuote}”</blockquote>
				</>
			) : null}
			{assessment?.collectionFields?.length ? (
				<p className="mt-2 text-xs text-muted-foreground">Asks for {assessment.collectionFields.map((field) => `“${describeDataEntryField(field)}”`).join(", ")}</p>
			) : null}
			{/* A confirmed site with no report: its case was confirmed from evidence collected elsewhere, after the site was gone; its info says why. */}
			{reportCount ? (
				<div className="mt-3 flex items-center justify-between gap-2 border-t border-destructive/15 pt-3 text-xs">
					<span className="text-muted-foreground">Being reported to the responsible providers.</span>
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

export function RedirectedPanel({ info, cloaks, redirectSubmissionId }: { info: string | null | undefined; cloaks: boolean; redirectSubmissionId: string | undefined }) {
	return (
		<div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
			<div className="text-xs font-semibold text-amber-700 dark:text-amber-400">{cloaks ? "Cloaks: shows scanners a different site" : "Redirects to another site"}</div>
			<div className="mt-1 text-sm whitespace-pre-wrap">{info}</div>
			{redirectSubmissionId ? (
				<Link href={`/submissions/${redirectSubmissionId}`} className="mt-2 inline-block text-sm font-medium text-primary hover:underline">
					Open the case for the destination
				</Link>
			) : null}
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
