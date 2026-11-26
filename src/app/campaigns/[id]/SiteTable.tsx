"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";

import type { PublicCampaignSite, SiteTakedown } from "@/lib/campaign/public_view";
import { formatDate, type Locale } from "@/lib/i18n/locale";
import { cn } from "@/lib/util/cn";
import { COPY } from "./copy";
import { languageName, MovedNote, scrollToId, takedownCounts, TakedownPill } from "./site_facts";
import { Thumb } from "./SitePicture";

type Filter = "all" | SiteTakedown;

/** The host a pasted link names, however much of it was pasted. */
export function pastedHost(input: string): string | undefined {
	const text = input.trim();
	if (!text) return undefined;
	try {
		return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname.toLowerCase().replace(/\.$/, "");
	} catch {
		return undefined;
	}
}

/**
 * Every site of the campaign as a row: its preview, address, language, when
 * it was found and whether it is down. A pasted link is checked against the
 * sites; a row opens its site in the browser above.
 */
export function SiteTable({ sites, selected, onSelect, linkedHost, brandDomain, locale }: { sites: PublicCampaignSite[]; selected: PublicCampaignSite; onSelect: (site: PublicCampaignSite) => void; linkedHost?: string; brandDomain?: string; locale: Locale }) {
	const copy = COPY[locale];
	const [filter, setFilter] = useState<Filter>("all");
	const [query, setQuery] = useState("");
	const counts = takedownCounts(sites);
	const filters: Array<[Filter, string]> = [["all", copy.filterAll(sites.length)], ...counts.map(({ state, count }): [Filter, string] => [state, `${copy.takedownState[state]} ${count}`])];
	const shown = sites.filter((site) => filter === "all" || site.takedown === filter);
	const host = pastedHost(query);
	const hit = host ? sites.find((site) => site.host === host) : undefined;
	// A pasted link that is one of the sites shows it in the browser, without moving the page.
	useEffect(() => {
		if (hit) onSelect(hit);
	}, [hit, onSelect]);
	const open = (site: PublicCampaignSite) => {
		onSelect(site);
		scrollToId("site-browser");
	};
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				{counts.length > 1 ? (
					<div className="inline-flex rounded-md bg-muted p-0.5 text-xs" role="group">
						{filters.map(([key, label]) => (
							<button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)} className={cn("rounded px-2.5 py-1", filter === key ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}>{label}</button>
						))}
					</div>
				) : <span />}
				<label className="relative min-w-0 flex-1 sm:max-w-sm">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
					<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.searchPlaceholder} aria-label={copy.searchPlaceholder} className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
				</label>
			</div>
			{host && (
				<p role="status" className={cn("rounded-md px-3 py-2 text-sm", hit ? "bg-red-600 font-medium text-white" : "border bg-muted/50")}>
					{hit ? <button type="button" onClick={() => open(hit)} className="text-left underline-offset-2 hover:underline">{copy.searchHit(hit.host)}</button> : copy.searchMiss(brandDomain)}
				</p>
			)}
			<div className="overflow-hidden rounded-lg border bg-card">
				<table className="w-full table-fixed text-sm">
					<thead className="bg-muted/50 text-left text-xs text-muted-foreground">
						<tr>
							<th className="px-3 py-2 font-medium">{copy.site}</th>
							<th className="hidden w-32 px-3 py-2 font-medium sm:table-cell">{copy.language}</th>
							<th className="hidden w-28 px-3 py-2 font-medium md:table-cell">{copy.firstSeen}</th>
							<th className="w-48 px-3 py-2 font-medium">{copy.status}</th>
						</tr>
					</thead>
					<tbody className="divide-y">
						{shown.map((site) => (
							<tr key={site.key} onClick={() => open(site)} className={cn("cursor-pointer hover:bg-muted/40", site === selected && "bg-muted/50", site.host === linkedHost && "ring-2 ring-inset ring-red-600")}>
								<td className="px-3 py-2">
									<div className="flex min-w-0 items-center gap-3">
										<Thumb site={site} emptyLabel="" className="h-10 w-9 shrink-0" />
										<div className="min-w-0">
											{/* The row is the click target; the button makes it reachable by keyboard. */}
											<button type="button" onClick={(event) => { event.stopPropagation(); open(site); }} className="block max-w-full truncate text-left font-mono text-xs font-medium hover:underline" title={site.host}>{site.host}</button>
											<span className="flex items-center gap-2 text-xs text-muted-foreground">
												{site.host === linkedHost && <span className="rounded bg-red-600 px-1.5 text-[11px] font-semibold text-white">{copy.yourSite}</span>}
												{copy.files(site.evidence.length)}
											</span>
										</div>
									</div>
								</td>
								<td className="hidden truncate px-3 py-2 text-xs sm:table-cell">{languageName(site.language, locale) ?? "–"}</td>
								<td className="hidden whitespace-nowrap px-3 py-2 text-xs tabular-nums text-muted-foreground md:table-cell">{formatDate(site.firstSeenAt, locale)}</td>
								<td className="px-3 py-2"><TakedownPill site={site} locale={locale} /><MovedNote site={site} locale={locale} className="mt-1 font-normal" /></td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
