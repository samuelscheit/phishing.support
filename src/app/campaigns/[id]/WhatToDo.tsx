"use client";

import { useState } from "react";
import { ArrowRight, ExternalLink } from "lucide-react";

import type { PublicCampaignVisitor } from "@/lib/campaign/public_view";
import type { Locale } from "@/lib/i18n/locale";
import { cn } from "@/lib/util/cn";
import { COPY, guideSteps, type Action, type Basis, type StepKind, type Tone } from "./copy";

const DOT: Record<Tone, string> = { safe: "bg-emerald-600", warn: "bg-amber-500", danger: "bg-red-600" };
const CALLOUT: Record<Tone, string> = { safe: "border-emerald-600 bg-emerald-50", warn: "border-amber-500 bg-amber-50", danger: "border-red-600 bg-red-50" };

/** One thing to do: the urgent one as a tinted callout, links in blue, things to know as plain text. */
function ActionItem({ action, tone, doFirst }: { action: Action; tone: Tone; doFirst?: string }) {
	const content = action.url ? <a href={action.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">{action.text}</a> : <span>{action.text}</span>;
	if (action.first) return <li className={cn("rounded-md border-l-4 px-3 py-2 font-semibold", CALLOUT[tone])}>{doFirst && <span className="mr-1">{doFirst}</span>}{content}</li>;
	if (action.fact) return <li className="text-muted-foreground">{content}</li>;
	const Icon = action.url ? ExternalLink : ArrowRight;
	return (
		<li className="flex gap-2">
			<Icon className={cn("mt-1 size-3.5 shrink-0", action.url ? "text-primary" : "text-foreground")} />
			{content}
		</li>
	);
}

/**
 * "What did you type in?" as one choice: the visitor picks the furthest they
 * got and sees what the criminals now have and what to do, then what
 * everyone who typed anything should do today.
 */
export function WhatToDo({ visitor, basis, locale }: { visitor: PublicCampaignVisitor; basis: Basis; locale: Locale }) {
	const copy = COPY[locale];
	const steps = guideSteps(locale, visitor, basis);
	const [picked, setPicked] = useState<StepKind>();
	const step = steps.find((candidate) => candidate.kind === picked);
	const afterwards = copy.afterwardsActions(visitor.brand, visitor.kinds, basis);
	const todo = step ? step.actions.filter((action) => !action.fact).length : 0;
	const hasLinks = Object.keys(visitor.brand?.links ?? {}).length > 0;
	return (
		<section id="what-to-do" className="scroll-mt-6 rounded-lg border bg-card p-4">
			<h2 className="text-sm font-semibold">{copy.howFar}</h2>
			<p className="text-xs text-muted-foreground">{copy.howFarSub}</p>
			<div className="mt-3 grid grid-cols-2 gap-1.5 text-sm" role="group" aria-label={copy.howFar}>
				{steps.map((candidate) => (
					<button key={candidate.kind} type="button" aria-pressed={candidate.kind === picked} onClick={() => setPicked(candidate.kind)} className={cn("flex min-h-10 items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors", candidate.kind === picked ? "border-foreground bg-foreground text-background" : "hover:bg-muted")}>
						<span className={cn("size-2 shrink-0 rounded-full", DOT[candidate.tone])} />{candidate.short}
					</button>
				))}
			</div>
			{step && (
				<div className="mt-4 space-y-3 text-sm">
					<p className="font-semibold">{step.did}.</p>
					<p className="text-pretty">{step.gets}</p>
					{step.actions.length > 0 && <ul className="space-y-2">{step.actions.map((action) => <ActionItem key={action.text} action={action} tone={step.tone} doFirst={todo > 1 ? copy.doFirst : undefined} />)}</ul>}
					{step.kind !== "opened" && afterwards.length > 0 && (
						<div className="space-y-2 border-t pt-3">
							<p className="font-semibold">{copy.afterwards}</p>
							<ul className="space-y-2">{afterwards.map((action) => <ActionItem key={action.text} action={action} tone="warn" />)}</ul>
						</div>
					)}
					{hasLinks && visitor.brand && <p className="text-xs text-muted-foreground">{copy.linksNote(visitor.brand.domain)}</p>}
				</div>
			)}
		</section>
	);
}
