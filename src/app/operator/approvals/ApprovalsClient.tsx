"use client";

import type { ReactNode } from "react";
import { Check, Copy, ExternalLink, Flag, Mail, X } from "lucide-react";

import { useCopy } from "@/components/useCopy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import type { DraftedMailView } from "@/lib/abuse/approval/drafted_mail";
import type { OpenEscalationStep } from "@/lib/abuse/escalation/manual";
import { formatUtcDateTime } from "@/lib/util/date_time";
import { DraftEditor, ErrorLine, useOperatorAction } from "../DraftedMail";

const KIND_LABEL: Record<string, string> = {
	cert: "National CERT",
	dsa_notice: "DSA notice to the host",
	brand: "Impersonated brand",
	complaint: "Criminal complaint",
	supplement: "Supplement",
	preservation_notice: "Preservation notice",
};

function MailCard({ mail }: { mail: DraftedMailView }) {
	return (
		<Card>
			<CardHeader className="gap-1 pb-3">
				<CardTitle className="flex flex-wrap items-center gap-2 text-base">
					<Mail className="h-4 w-4" />
					{KIND_LABEL[mail.kind] ?? mail.kind}
					{mail.target && <Badge variant="secondary" className="font-mono">{mail.target}</Badge>}
				</CardTitle>
				<CardDescription className="break-words">
					To {mail.recipientLabel} &lt;{mail.recipient}&gt; · drafted {formatUtcDateTime(mail.createdAt)}
					{mail.contextHref && <> · <a href={mail.contextHref} className="text-primary underline-offset-4 hover:underline">{mail.contextHref.startsWith("/operator/campaigns/") ? "campaign and attachments" : "case"}</a></>}
				</CardDescription>
			</CardHeader>
			<CardContent>
				<DraftEditor mail={mail} />
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
				<Button size="sm" variant={filed ? "ghost" : "outline"} disabled={busy} onClick={() => run(url, { resolution: "dismissed" })}><X />{filed ? "Dismiss" : "Done"}</Button>
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
					ICANN takes complaints through its web form only. Check that {step.registrar ?? "the registrar"} is the accredited registrar (not a reseller), choose &quot;Abuse/DNS Abuse (Registrar)&quot;, paste the text and attach the case&apos;s evidence.
					{" "}Prepared {formatUtcDateTime(step.at)}{step.caseHref && <> · <a href={step.caseHref} className="text-primary underline-offset-4 hover:underline">case</a></>}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				<Textarea readOnly value={step.text ?? ""} rows={14} className="font-mono text-xs leading-relaxed" />
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
					Two weeks after the first report the site still serves what was reported, and nothing automatic is left. Consider a criminal referral of its campaign.
					{" "}{formatUtcDateTime(step.at)}{step.caseHref && <> · <a href={step.caseHref} className="text-primary underline-offset-4 hover:underline">case</a></>}
				</CardDescription>
			</CardHeader>
			<CardContent>
				<StepActions step={step} />
			</CardContent>
		</Card>
	);
}

export function ApprovalsClient({ mails, steps }: { mails: DraftedMailView[]; steps: OpenEscalationStep[] }) {
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
		</div>
	);
}
