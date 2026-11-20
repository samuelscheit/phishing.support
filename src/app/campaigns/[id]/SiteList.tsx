"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, ArrowUp, ChevronDown, FileSearch } from "lucide-react";

import { Collapsible } from "@/components/Collapsible";
import type { PublicCampaign, PublicCampaignSite } from "@/lib/campaign/public_view";
import { formatDate, type Locale } from "@/lib/i18n/locale";
import { cn } from "@/lib/util/cn";
import { COPY } from "./copy";
import { BrowserFrame, Thumb } from "./SitePicture";

const COLLAPSED_ROWS = 2;
/** How much of the next row shows under the fade, saying there is more. */
const ROW_PEEK = 48;
/** Report states that reached the provider. */
const DELIVERED = new Set<PublicCampaignSite["reports"][number]["state"]>(["accepted", "awaiting", "confirmed", "rejected"]);

/** Scrolls to an element without replacing the `#host` that names the visitor's site. */
export function scrollToId(id: string) {
	document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function TakedownPill({ site, locale }: { site: PublicCampaignSite; locale: Locale }) {
	const down = site.takedown === "confirmed";
	return (
		<span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", down ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800")}>
			<span className="size-1.5 rounded-full bg-current" />
			{down ? COPY[locale].takenDown : COPY[locale].notTakenDown}
		</span>
	);
}

/**
 * Every site, newest first, as a row that opens into a mini case: its
 * picture, whether it is down, a way back to the steps, and its full
 * analysis. A `#host` link and `focus` (a dot on the time line) open a row.
 */
export function SiteList({ campaign, locale, linkedHost, focus }: { campaign: PublicCampaign; locale: Locale; linkedHost?: string; focus?: { id: string; at: number } }) {
	const copy = COPY[locale];
	const [open, setOpen] = useState<string>();
	const [expanded, setExpanded] = useState(false);
	useEffect(() => {
		const site = campaign.sites.find((candidate) => candidate.host === linkedHost);
		if (!site) return;
		// The page stays at its top, where the banner names the host; the row waits open in the list.
		setExpanded(true);
		setOpen(site.submissionId);
	}, [campaign.sites, linkedHost]);
	useEffect(() => {
		if (!focus) return;
		setExpanded(true);
		setOpen(focus.id);
	}, [focus]);
	// Scrolls once per dot click, after the list is expanded and the row open, so the row is where it ends up.
	const scrolled = useRef<number>(undefined);
	useEffect(() => {
		if (!focus || scrolled.current === focus.at || open !== focus.id || !expanded) return;
		scrolled.current = focus.at;
		document.getElementById(`site-${focus.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
	}, [focus, open, expanded]);
	// An opened row must never sit under the fade of the collapsed list.
	const toggle = (id: string) => {
		setOpen(open === id ? undefined : id);
		if (open !== id) setExpanded(true);
	};
	const sites = [...campaign.sites].sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt));

	return (
		<Collapsible rows={COLLAPSED_ROWS} peek={ROW_PEEK} count={sites.length} more={copy.showAll(sites.length)} less={copy.showFewer} expanded={expanded} onExpandedChange={setExpanded} listClassName="divide-y">
			{sites.map((site) => {
				const isOpen = open === site.submissionId;
				const isLinked = site.host === linkedHost;
				const reportedTo = new Set(site.reports.filter((report) => DELIVERED.has(report.state)).map((report) => report.provider)).size;
				return (
					<li key={site.submissionId} id={`site-${site.submissionId}`} className={cn("scroll-mt-6", isOpen && "bg-muted/30", isLinked && "relative ring-2 ring-inset ring-red-600")}>
						<button type="button" aria-expanded={isOpen} onClick={() => toggle(site.submissionId)} className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-muted/40 sm:gap-4 sm:px-4">
							<Thumb site={site} emptyLabel={copy.noPicture} className="w-20 shrink-0 sm:w-24" />
							<span className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-6">
								<span className="min-w-0 sm:w-72 sm:shrink-0">
									<span className="flex min-w-0 items-center gap-2">
										<span className="truncate font-mono text-sm font-medium">{site.host}</span>
										{isLinked && <span className="shrink-0 rounded bg-red-600 px-1.5 py-px text-[11px] font-semibold text-white">{copy.yourSite}</span>}
									</span>
									<span className="block text-xs text-muted-foreground">{copy.firstSeen} {formatDate(site.firstSeenAt, locale)}</span>
								</span>
								<span><TakedownPill site={site} locale={locale} /></span>
							</span>
							<ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-180")} />
						</button>
						{isOpen && (
							<div className={cn("grid gap-4 px-4 pb-5", site.blankCapture ? "sm:pl-32" : "sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]")}>
								{!site.blankCapture && <BrowserFrame site={site} alt={copy.screenshotAlt(site.host)} />}
								<div className="space-y-3 text-sm">
									{site.takedown === "confirmed"
										? <p className="font-semibold text-emerald-700">{copy.rowTakenDown}</p>
										: <p className="flex items-center gap-2 font-semibold text-red-700"><AlertTriangle className="size-4 shrink-0" />{copy.rowVerdict}</p>}
									{site.takedown !== "confirmed" && <p className="text-muted-foreground">{copy.rowReports(reportedTo)}</p>}
									<button type="button" onClick={() => scrollToId("what-to-do")} className="inline-flex items-center gap-1.5 text-left font-medium text-primary hover:underline">{copy.rowWhatToDo}<ArrowUp className="size-4 shrink-0" /></button>
									<a href={`/submissions/${site.submissionId}`} className="flex w-fit items-center gap-2 rounded-xl border bg-background px-4 py-2.5 font-medium shadow-sm transition-colors hover:bg-accent">
										<FileSearch className="size-4 shrink-0 text-muted-foreground" />{copy.rowAnalysis}<ArrowRight className="size-4 shrink-0" />
									</a>
								</div>
							</div>
						)}
					</li>
				);
			})}
		</Collapsible>
	);
}
