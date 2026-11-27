"use client";

import type { ReactNode } from "react";
import { Check, Copy, ExternalLink, Flag, Mail, X } from "lucide-react";

import { useCopy } from "@/components/useCopy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import type { DraftedMailView } from "@/lib/abuse/approval/drafted_mail";
import type { OpenEscalationStep, UpcomingEscalationStep } from "@/lib/abuse/escalation/manual";
import { formatUtcDateTime } from "@/lib/util/date_time";
import { DraftEditor, ErrorLine, useOperatorAction } from "../DraftedMail";
import { UpcomingSteps } from "./UpcomingSteps";

const KIND_LABEL: Record<string, string> = {
	cert: "National CERT",
	dsa_notice: "DSA notice to the host",
	brand: "Impersonated brand",
	complaint: "Criminal complaint",
	supplement: "Supplement",
	preservation_notice: "Preservation notice",
};

function ContextLink({ href, label }: { href: string; label: string }) {
	return <a href={href} className="text-primary underline-offset-4 hover:underline">{label}</a>;
}

/** One mail waiting: whom it goes to and why at a glance; the mail itself opens to be read, edited and approved. */
function MailCard({ mail }: { mail: DraftedMailView }) {
	return (
		<Card>
			<CardHeader className="gap-1.5 pb-3">
				<CardTitle className="flex flex-wrap items-center gap-2 text-base">
					<Mail className="h-4 w-4" />
					{KIND_LABEL[mail.kind] ?? mail.kind}
					{mail.target && <Badge variant="secondary" className="font-mono">{mail.target}</Badge>}
				</CardTitle>
				<p className="break-words text-sm">To <span className="font-medium">{mail.recipientLabel}</span> &lt;{mail.recipient}&gt;</p>
				{mail.reason && <CardDescription className="break-words">{mail.reason}</CardDescription>}
				<CardDescription>
					Drafted {formatUtcDateTime(mail.createdAt)}
					{mail.context && <> · <ContextLink href={mail.context.href} label={mail.context.label === "campaign" ? "Open campaign (attachments)" : "Open case"} /></>}
				</CardDescription>
			</CardHeader>
			<CardContent>
				<details className="group rounded-md border bg-muted/30">
					<summary className="cursor-pointer px-3 py-2 text-sm"><span className="font-medium">Review and approve</span> <span className="text-muted-foreground">· {mail.subject}</span></summary>
					<div className="border-t bg-background p-3">
						<DraftEditor mail={mail} />
					</div>
				</details>
			</CardContent>
		</Card>
	);
}

/** Settling a step, after the step's own tools (`children`). */
function StepActions({ step, filed, children }: { step: OpenEscalationStep; filed?: string; children?: ReactNode }) {
	const { busy, error, run } = useOperatorAction();
	const url = `/api/operator/escalation-steps/${step.eventId}`;
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-2">
				{children}
				{filed && <Button size="sm" disabled={busy} onClick={() => run(url, { resolution: "filed" })}><Check />{filed}</Button>}
				<Button size="sm" variant="ghost" disabled={busy} onClick={() => run(url, { resolution: "dismissed" })}><X />Dismiss</Button>
			</div>
			<ErrorLine error={error} />
		</div>
	);
}

function IcannCard({ step }: { step: OpenEscalationStep }) {
	const { copied, copy } = useCopy();
	return (
		<Card>
			<CardHeader className="gap-1 pb-3">
				<CardTitle className="flex flex-wrap items-center gap-2 text-base">
					<Flag className="h-4 w-4" />ICANN complaint against {step.registrar ?? "the registrar"}
					<Badge variant="secondary" className="font-mono">{step.target}</Badge>
				</CardTitle>
				<CardDescription>
					Prepared {formatUtcDateTime(step.at)}{step.caseHref && <> · <ContextLink href={step.caseHref} label="Open case" /></>}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				<ol className="list-decimal space-y-1 pl-5 text-sm">
					<li>Check that {step.registrar ?? "the registrar"} is the ICANN-accredited registrar of {step.target}, not a reseller (lookup.icann.org).</li>
					<li>Open ICANN&apos;s form and choose &quot;Abuse/DNS Abuse (Registrar)&quot;; ICANN takes no complaints by mail.</li>
					<li>Paste the text below and attach the screenshots from the case.</li>
				</ol>
				<label className="block space-y-1">
					<span className="text-xs font-medium text-muted-foreground">Complaint text (read-only, copy it into the form)</span>
					<Textarea readOnly value={step.text ?? ""} className="max-h-[60vh] [field-sizing:content] font-mono text-xs leading-relaxed" />
				</label>
				<StepActions step={step} filed="Mark as filed">
					<Button size="sm" variant="outline" onClick={() => copy(step.text ?? "")}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy text"}</Button>
					{step.formUrl && <Button size="sm" variant="outline" asChild><a href={step.formUrl} target="_blank" rel="noreferrer"><ExternalLink />Open ICANN form</a></Button>}
				</StepActions>
			</CardContent>
		</Card>
	);
}

function DecisionCard({ step }: { step: OpenEscalationStep }) {
	return (
		<Card>
			<CardHeader className="gap-1 pb-3">
				<CardTitle className="flex flex-wrap items-center gap-2 text-base">
					<Flag className="h-4 w-4" />Still online after every escalation
					<Badge variant="secondary" className="font-mono">{step.target}</Badge>
				</CardTitle>
				<CardDescription>
					Two weeks after the first report the site still serves what was reported, and nothing automatic is left. Consider a criminal referral of its campaign. Since {formatUtcDateTime(step.at)}.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<StepActions step={step}>
					{step.caseHref && <Button size="sm" variant="outline" asChild><a href={step.caseHref}><ExternalLink />Open case</a></Button>}
				</StepActions>
			</CardContent>
		</Card>
	);
}

export function ApprovalsClient({ mails, steps, upcoming, now }: { mails: DraftedMailView[]; steps: OpenEscalationStep[]; upcoming: UpcomingEscalationStep[]; now: string }) {
	return (
		<div className="space-y-8">
			{mails.length > 0 && (
				<section className="space-y-3">
					<h2 className="text-lg font-semibold">Mails waiting for your approval <span className="text-muted-foreground">({mails.length})</span></h2>
					{mails.map((mail) => <MailCard key={mail.routeId} mail={mail} />)}
				</section>
			)}
			{steps.length > 0 && (
				<section className="space-y-3">
					<h2 className="text-lg font-semibold">Steps only you can take <span className="text-muted-foreground">({steps.length})</span></h2>
					{steps.map((step) => (step.kind === "icann_complaint" ? <IcannCard key={step.eventId} step={step} /> : <DecisionCard key={step.eventId} step={step} />))}
				</section>
			)}
			{upcoming.length > 0 && <UpcomingSteps steps={upcoming} now={now} />}
		</div>
	);
}
