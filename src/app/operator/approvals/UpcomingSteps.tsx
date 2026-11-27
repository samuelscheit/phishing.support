"use client";

import { Clock, ExternalLink, Send, SkipForward } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { UpcomingEscalationStep } from "@/lib/abuse/escalation/manual";
import { untilText } from "@/lib/submissions/report_view";
import { cn } from "@/lib/util/cn";
import { formatUtcDateTime } from "@/lib/util/date_time";
import { ErrorLine, useOperatorAction } from "../DraftedMail";

const STEP_LABEL: Record<UpcomingEscalationStep["step"], string> = {
	follow_up: "Follow-up",
	next_contact: "Next contact",
	upstream: "Upstream provider",
	oversight: "Oversight drafts",
	exhausted: "Your decision",
};

/** What the step does, in a line: to whom, or what it prepares. */
function what(step: UpcomingEscalationStep): string {
	const to = step.to ? `${step.to.name}${step.to.address !== step.to.name ? ` <${step.to.address}>` : ""}` : undefined;
	switch (step.step) {
		case "follow_up": return `${step.to && !step.to.address.includes("@") ? `Again through ${step.to.address}` : `Again to ${to ?? step.provider}`}, with proof the site still serves it`;
		case "next_contact": return `New report to ${to}, ${step.provider}'s next published contact`;
		case "upstream": return `New report to ${to}, upstream of ${step.provider}`;
		case "oversight": return "Drafts to the national CERT, an EU host's DSA notice, the brand, and the ICANN complaint, for your approval";
		case "exhausted": return "Nothing automatic is left: decide on a criminal referral";
	}
}

function StepRow({ step, now }: { step: UpcomingEscalationStep; now: string }) {
	const { busy, error, run } = useOperatorAction();
	const url = `/api/operator/escalation-plan/${step.targetId}`;
	return (
		<li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
			<div className="min-w-0 space-y-1">
				<div className="flex flex-wrap items-center gap-2 text-sm">
					<span className="font-medium">{STEP_LABEL[step.step]}</span>
					<span className="text-muted-foreground">{step.provider ?? "whole site"}</span>
					<Badge variant="secondary" className="max-w-full truncate font-mono">{step.target}</Badge>
					{step.caseHref ? <a href={step.caseHref} className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"><ExternalLink className="h-3 w-3" />Case</a> : null}
				</div>
				<p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">{what(step)}</p>
				{step.heldUntil ? <p className="text-xs text-muted-foreground">On hold until {formatUtcDateTime(step.heldUntil)}: the last check did not find the reported content.</p> : null}
				<ErrorLine error={error} />
			</div>
			<div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
				<span title={formatUtcDateTime(step.at)} className={cn("inline-flex items-center gap-1 text-xs tabular-nums", step.due ? "text-amber-700" : "text-muted-foreground")}>
					<Clock className="h-3 w-3" aria-hidden />
					{step.due ? "due" : untilText(step.at, now)}{step.advanced ? " · brought forward" : ""}
				</span>
				<span className="flex gap-2">
					{/* Brought forward and not held since: the job takes it now already. */}
					<Button size="sm" variant="outline" disabled={busy || (step.advanced && !step.heldUntil)} onClick={() => run(url, { step: step.key, action: "send_now" })}><Send />Send now</Button>
					<Button size="sm" variant="ghost" disabled={busy} onClick={() => run(url, { step: step.key, action: "skip" })}><SkipForward />Skip</Button>
				</span>
			</div>
		</li>
	);
}

/**
 * The next escalation step of every route and site still on a ladder,
 * soonest first. Send now takes it right away (after the check that the site
 * still serves the reported content); Skip leaves it out and moves on.
 */
export function UpcomingSteps({ steps, now }: { steps: UpcomingEscalationStep[]; now: string }) {
	return (
		<section className="space-y-3">
			<div className="space-y-1">
				<h2 className="text-lg font-semibold">Upcoming escalation steps <span className="text-muted-foreground">({steps.length})</span></h2>
				<p className="text-sm text-muted-foreground">Each goes out on its own when due, if a check then finds the site still serving the reported content.</p>
			</div>
			<Card className="overflow-hidden p-0">
				<ul className="divide-y">{steps.map((step) => <StepRow key={`${step.targetId}:${step.key}`} step={step} now={now} />)}</ul>
			</Card>
		</section>
	);
}
