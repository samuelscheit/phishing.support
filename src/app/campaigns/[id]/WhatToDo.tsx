"use client";

import { ArrowRight, AtSign, CreditCard, ExternalLink, Eye, Hash, KeyRound, Landmark, Phone, ShieldCheck, UserRound } from "lucide-react";

import { Collapsible } from "@/components/Collapsible";
import type { PublicCampaignSite, PublicCampaignVisitor } from "@/lib/campaign/public_view";
import type { Locale } from "@/lib/i18n";
import { cn } from "@/web_lib/util";
import { COPY, guideSteps, type Action, type Basis, type GuideStep, type StepKind, type Tone } from "./copy";
import { BrowserFrame } from "./SitePicture";

/** Steps shown whole before the list is expanded; the next one peeks under the fade. */
const VISIBLE_STEPS = 2;
const STEP_PEEK = 88;

const TONE: Record<Tone, string> = { safe: "bg-emerald-600 text-white", warn: "bg-amber-500 text-white", danger: "bg-red-600 text-white" };
const CALLOUT: Record<Tone, string> = { safe: "border-emerald-600 bg-emerald-50", warn: "border-amber-500 bg-amber-50", danger: "border-red-600 bg-red-50" };
const ICON: Record<StepKind, typeof Eye> = { opened: Eye, email: AtSign, password: KeyRound, code: Hash, phone: Phone, card: CreditCard, payment: Landmark, personal: UserRound };

/** The same circle for every step: what was typed as the icon, how bad it is as the colour. */
function Marker({ icon: Icon, className }: { icon: typeof Eye; className: string }) {
	return <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full", className)}><Icon className="size-4" /></span>;
}

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

function Step({ step, doFirst }: { step: GuideStep; doFirst: string }) {
	const todo = step.actions.filter((action) => !action.fact).length;
	return (
		<li className="flex gap-3">
			<Marker icon={ICON[step.kind]} className={TONE[step.tone]} />
			<div className="min-w-0 flex-1 space-y-2">
				<p className="pt-1 font-semibold">{step.did}.</p>
				<p className="text-pretty">{step.gets}</p>
				{step.actions.length > 0 && <ul className="space-y-2">{step.actions.map((action) => <ActionItem key={action.text} action={action} tone={step.tone} doFirst={todo > 1 ? doFirst : undefined} />)}</ul>}
			</div>
		</li>
	);
}

/**
 * "What did you type in?": each thing a visitor may have typed, what the
 * criminals now have and what to do, then what everyone who typed anything
 * should do today. The picture of the fake page sits beside the steps on
 * desktop, its top on the box's top; on a phone it comes before the heading,
 * so a jump to the heading lands on the advice, not on the picture.
 */
export function WhatToDo({ visitor, basis, locale, shown, caption }: { visitor: PublicCampaignVisitor; basis: Basis; locale: Locale; shown: PublicCampaignSite | undefined; caption: string }) {
	const copy = COPY[locale];
	const steps = guideSteps(locale, visitor, basis);
	const afterwards = copy.afterwardsActions(visitor.brand, visitor.kinds, basis);
	const hidden = steps.slice(VISIBLE_STEPS);
	const hasLinks = Object.keys(visitor.brand?.links ?? {}).length > 0;
	return (
		<section className="grid grid-cols-[minmax(0,1fr)] items-start gap-x-8 gap-y-6 md:grid-cols-[minmax(0,1fr)_16rem]">
			{shown && (
				<figure className="space-y-2 md:sticky md:top-6 md:col-start-2 md:row-start-2">
					<div className="max-h-60 overflow-hidden rounded-lg md:max-h-none"><BrowserFrame site={shown} alt={copy.screenshotAlt(shown.host)} /></div>
					<figcaption className="text-xs text-muted-foreground">{caption}</figcaption>
				</figure>
			)}
			<div id="what-to-do" className="max-w-3xl scroll-mt-6 space-y-1 md:col-start-1 md:row-start-1">
				<h2 className="text-xl font-semibold tracking-tight sm:text-2xl">{copy.howFar}</h2>
				<p className="text-pretty text-muted-foreground">{copy.howFarSub}</p>
			</div>
			<div className="max-w-3xl space-y-6 md:col-start-1 md:row-start-2">
				<Collapsible as="ol" rows={VISIBLE_STEPS} peek={STEP_PEEK} count={steps.length} more={copy.showMoreSteps(hidden.map((step) => step.short))} less={copy.showFewer} listClassName="space-y-6 p-5">
					{steps.map((step) => <Step key={step.kind} step={step} doFirst={copy.doFirst} />)}
				</Collapsible>
				{afterwards.length > 0 && (
					<div className="flex gap-3 px-5">
						<Marker icon={ShieldCheck} className="bg-slate-700 text-white" />
						<div className="min-w-0 flex-1 space-y-2">
							<p className="pt-1 font-semibold">{copy.afterwards}</p>
							<ul className="space-y-2">{afterwards.map((action) => <ActionItem key={action.text} action={action} tone="warn" />)}</ul>
							{hasLinks && visitor.brand && <p className="text-xs text-muted-foreground">{copy.linksNote(visitor.brand.domain)}</p>}
						</div>
					</div>
				)}
			</div>
		</section>
	);
}
