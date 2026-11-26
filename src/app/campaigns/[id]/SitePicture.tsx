"use client";

import { useEffect, useRef } from "react";
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";

import { Address } from "@/components/Address";
import type { PublicCampaignSite } from "@/lib/campaign/public_view";
import { formatDate, type Locale } from "@/lib/i18n/locale";
import { cn } from "@/lib/util/cn";
import { COPY } from "./copy";
import { languageName, MovedNote, TAKEDOWN_STYLE, TakedownPill } from "./site_facts";

/** The picture of a site: its trimmed capture when there is one, else the full capture. */
function pictureOf(site: PublicCampaignSite): string | undefined {
	return site.blankCapture ? undefined : site.thumbnailUrl ?? site.screenshotUrl;
}

/**
 * The campaign's sites one at a time in the case page's browser frame: the
 * address bar with the registered domain standing out, the picked site's
 * trimmed capture, its facts, and a strip of every site to step through.
 */
export function SiteBrowser({ sites, selected, onSelect, linkedHost, locale }: { sites: PublicCampaignSite[]; selected: PublicCampaignSite; onSelect: (site: PublicCampaignSite) => void; linkedHost?: string; locale: Locale }) {
	const copy = COPY[locale];
	const index = sites.indexOf(selected);
	const src = pictureOf(selected);
	const step = (by: number) => onSelect(sites[(index + by + sites.length) % sites.length]!);
	const strip = useRef<HTMLOListElement>(null);
	useEffect(() => {
		// Only the strip scrolls: the page stays where the visitor is reading.
		const list = strip.current;
		const item = list?.children[index] as HTMLElement | undefined;
		if (list && item) list.scrollTo({ left: item.offsetLeft - (list.clientWidth - item.clientWidth) / 2, behavior: "smooth" });
	}, [index]);
	const language = languageName(selected.language, locale);
	return (
		<div id="site-browser" className="scroll-mt-6 overflow-hidden rounded-lg border bg-card shadow-sm">
			<div className="flex items-center gap-1.5 border-b bg-muted/60 px-3 py-2">
				<div className="mr-1 flex gap-1.5" aria-hidden>
					{[0, 1, 2].map((dot) => <span key={dot} className="size-2.5 rounded-full bg-muted-foreground/30" />)}
				</div>
				{sites.length > 1 && (
					<>
						<button type="button" onClick={() => step(-1)} aria-label={copy.previousSite} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><ChevronLeft className="size-4" /></button>
						<button type="button" onClick={() => step(1)} aria-label={copy.nextSite} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><ChevronRight className="size-4" /></button>
					</>
				)}
				{/* Only the host: the part a visitor must learn to check; the full address is the title. */}
				<div className="min-w-0 flex-1 truncate rounded-md bg-background px-2.5 py-1 text-xs" title={selected.url}>
					<Address url={selected.url} bare />
				</div>
				{sites.length > 1 && <span className="hidden shrink-0 pl-1 text-xs tabular-nums text-muted-foreground sm:inline">{copy.siteOf(index + 1, sites.length)}</span>}
			</div>
			{/* A trimmed kit card shows at its own width on the muted page; a wide capture fills the frame. */}
			<div className="relative flex min-h-48 justify-center bg-muted">
				{src ? (
					<a href={selected.screenshotUrl ?? src} target="_blank" rel="noreferrer" className="max-w-full">
						{/* eslint-disable-next-line @next/next/no-img-element */}
						<img src={src} alt={copy.screenshotAlt(selected.host)} className="block h-auto max-h-[min(60vh,32rem)] w-auto max-w-full bg-white" />
					</a>
				) : <span className="self-center text-sm text-muted-foreground">{copy.noPicture}</span>}
				<span className="absolute left-3 top-3 rounded-md bg-foreground/85 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-background">{copy.fakeStamp}</span>
			</div>
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t px-3 py-2 text-xs">
				<span className="text-muted-foreground">{[language, `${copy.firstSeen} ${formatDate(selected.firstSeenAt, locale)}`, copy.pagesCaptured(Math.max(1, selected.steps.length))].filter(Boolean).join(" · ")}</span>
				<span className="flex items-center gap-3">
					<TakedownPill site={selected} locale={locale} />
					<a href={`/submissions/${selected.submissionId}`} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">{copy.openCase}<ArrowRight className="size-3.5" /></a>
				</span>
				<MovedNote site={selected} locale={locale} className="basis-full" />
			</div>
			{sites.length > 1 && (
				<ol ref={strip} className="relative flex gap-2 overflow-x-auto border-t bg-muted/40 p-2.5" aria-label={copy.tabSites(sites.length)}>
					{sites.map((site) => (
						<li key={site.key} className="shrink-0">
							<button type="button" onClick={() => onSelect(site)} title={site.host} aria-current={site === selected ? "true" : undefined} className={cn("relative block rounded-md transition-shadow", site === selected ? "ring-2 ring-foreground ring-offset-2 ring-offset-muted" : "hover:ring-1 hover:ring-foreground/30", site.host === linkedHost && site !== selected && "ring-2 ring-red-600")}>
								<Thumb site={site} emptyLabel={copy.noPicture} className="h-20 w-[4.5rem]" />
								<span className={cn("absolute bottom-1 right-1 size-2 rounded-full ring-2 ring-white", TAKEDOWN_STYLE[site.takedown].dot)} />
							</button>
						</li>
					))}
				</ol>
			)}
		</div>
	);
}

/** A small preview, or a neutral box saying there is none. */
export function Thumb({ site, emptyLabel, className }: { site: PublicCampaignSite; emptyLabel: string; className?: string }) {
	const src = pictureOf(site);
	return (
		<div className={cn("relative overflow-hidden rounded-md border bg-muted", className)}>
			{src
				// eslint-disable-next-line @next/next/no-img-element
				? <img src={src} alt="" loading="lazy" className="absolute inset-0 size-full bg-white object-cover object-left-top" />
				: <span className="absolute inset-0 flex items-center justify-center text-center text-[10px] text-muted-foreground">{emptyLabel}</span>}
		</div>
	);
}
