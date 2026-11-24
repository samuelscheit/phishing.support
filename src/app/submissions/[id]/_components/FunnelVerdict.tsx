import Link from "next/link";
import { Route } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { label, statusClass } from "@/components/SubmissionReports";
import type { DeceptiveFunnelFinding } from "@/lib/abuse/funnel/classification";
import { DECEPTION_PHRASES } from "@/lib/abuse/funnel/deception";
import type { FunnelParty } from "@/lib/abuse/funnel/extract";
import { platformLabel } from "@/lib/abuse/funnel/platforms";
import type { SubmissionReport } from "@/lib/submissions/details";
import type { WebsiteFunnel } from "@/lib/website/types";
import { cn } from "@/lib/util/cn";

/** How the business knows the affiliate: its own ID, or the one the network that delivered the visitor credits. */
function affiliateOf(party: FunnelParty): string {
	if (party.affiliateIds.length) return party.affiliateIds.join(", ");
	return `${party.creditedBy!.id}, credited by ${party.creditedBy!.site}`;
}

/** What became of one business's report: sent to its recipient by this case, by another case it joined, or left out. */
function PartyReport({ party, report, skipped, caseId }: { party: FunnelParty; report?: SubmissionReport; skipped?: string; caseId: string }) {
	if (skipped) return <p className="text-xs text-muted-foreground">Not reported: {skipped}.</p>;
	if (!report) return <p className="text-xs text-muted-foreground">No report.</p>;
	const owner = report.submissionId !== null && String(report.submissionId) !== caseId ? String(report.submissionId) : undefined;
	const recipients = [...new Set(report.routes.flatMap((route) => (route.recipient ? [route.recipient] : [])))];
	return (
		<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
			<Badge variant="outline" className={cn("capitalize", statusClass(report.status))}>{label(report.status)}</Badge>
			<span className="text-muted-foreground">
				{recipients.length ? `to ${recipients.join(", ")}` : `${party.site}'s contact is being looked up`}
				{owner ? <> · reported by <Link href={`/submissions/${owner}`} className="font-medium text-primary hover:underline">case {owner}</Link></> : null}
			</span>
		</div>
	);
}

/**
 * The chain judged as a deceptive affiliate funnel: what its lure claimed,
 * what it led to, and each business that can terminate the affiliate, with
 * the ID it knows the affiliate by and what became of its report.
 */
export function FunnelVerdict({ funnel, reports, caseId }: { funnel: WebsiteFunnel & { verdict: DeceptiveFunnelFinding }; reports: readonly SubmissionReport[]; caseId: string }) {
	const { verdict, extraction } = funnel;
	const [quote] = verdict.lureQuotes;
	return (
		<div>
			<div className="flex items-center gap-2 text-sm font-semibold text-destructive">
				<Route className="h-4 w-4 shrink-0" />
				Deceptive affiliate funnel
			</div>
			<p className="mt-1 text-xs text-muted-foreground">The lure is {DECEPTION_PHRASES[verdict.deceptionKind]}.</p>
			<p className="mt-2 text-sm">{verdict.lureClaim}</p>
			<p className="mt-1 text-sm"><span className="text-muted-foreground">In fact: </span>{verdict.reality}</p>
			{quote ? (
				<>
					<div className="mt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Evidence</div>
					<blockquote className="mt-1 border-l-2 pl-2 text-xs text-muted-foreground">“{quote.quote}”</blockquote>
					<blockquote className="mt-1 border-l-2 pl-2 text-xs text-muted-foreground">Offer: “{verdict.offerQuote.quote}”</blockquote>
				</>
			) : null}
			<div className="mt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Affiliate, per business</div>
			<ul className="mt-1 space-y-2">
				{extraction.parties.map((party) => {
					const platform = platformLabel(party.platform, party.platformConfidence);
					const report = reports.find((candidate) => candidate.funnelParty?.role === party.role && candidate.funnelParty.site === party.site);
					const skipped = funnel.skipped?.find((left) => left.role === party.role && left.site === party.site)?.reason;
					return (
						<li key={`${party.role}:${party.site}`} className="space-y-1">
							<div className="text-xs">
								<span className="font-mono">{party.site}</span>
								<span className="text-muted-foreground"> · {party.role === "merchant" ? "merchant" : `network${platform ? ` (${platform})` : ""}`} · affiliate </span>
								<span className="font-mono">{affiliateOf(party)}</span>
							</div>
							<PartyReport party={party} report={report} skipped={skipped} caseId={caseId} />
						</li>
					);
				})}
			</ul>
		</div>
	);
}
