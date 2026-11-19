"use client";

/**
 * Whether the people behind a campaign are still at work, and when its sites
 * appeared: one dot per site on a time line up to today, a hollow green ring
 * once taken down, solid red until then; a dot opens its site in the list.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { PublicCampaign, PublicCampaignSite } from "@/lib/campaign/public_view";
import { formatDate, type Locale } from "@/lib/i18n";
import { cn } from "@/web_lib/util";
import { COPY } from "./copy";
import { DOT, LANE, placeDots } from "./timeline_layout";

/** Quiet this long, the people behind a campaign no longer count as active. */
const ACTIVE_DAYS = 14;
const DAY_MS = 86_400_000;

/** Whole calendar days between two instants in the viewer's own time zone. */
function calendarDays(from: number, to: number): number {
	const day = (time: number) => { const date = new Date(time); return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()); };
	return Math.round((day(to) - day(from)) / DAY_MS);
}

/** The current time once mounted: relative words and the axis end follow the viewer's clock, not the server's. */
function useNow(): number | undefined {
	const [now, setNow] = useState<number>();
	useEffect(() => setNow(Date.now()), []);
	return now;
}

export function ActiveLine({ campaign, locale }: { campaign: PublicCampaign; locale: Locale }) {
	const copy = COPY[locale];
	const now = useNow();
	const n = campaign.sites.length;
	if (now === undefined) return <p className="min-h-10 sm:min-h-5" />;
	const quietDays = calendarDays(Date.parse(campaign.lastSeenAt), now);
	if (quietDays >= ACTIVE_DAYS) return <p className="text-sm text-muted-foreground">{copy.quiet(formatDate(campaign.lastSeenAt, locale), n)}</p>;
	const ago = quietDays <= 0 ? copy.today : quietDays === 1 ? copy.yesterday : copy.daysAgo(quietDays);
	return (
		<p className="flex items-start gap-2 text-sm font-medium text-red-700">
			<span className="relative mt-1.5 flex size-2 shrink-0">
				<span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-60 motion-reduce:hidden" />
				<span className="relative inline-flex size-2 rounded-full bg-red-600" />
			</span>
			{copy.active(ago, n)}
		</p>
	);
}

export function Timeline({ campaign, locale, onOpen }: { campaign: PublicCampaign; locale: Locale; onOpen: (site: PublicCampaignSite) => void }) {
	const copy = COPY[locale];
	const now = useNow();
	const track = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const element = track.current;
		if (!element) return;
		const observer = new ResizeObserver(() => setWidth(element.clientWidth));
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const start = Date.parse(campaign.firstSeenAt);
	const last = Date.parse(campaign.lastSeenAt);
	const end = Math.max(last, now ?? 0);
	const { dots, more } = width && now ? placeDots(campaign.sites, width, start, end) : { dots: [], more: [] };
	const down = campaign.sites.filter((site) => site.takedown === "confirmed").length;
	// Tall enough for the stacks drawn, plus a lane for "+N" when a spot overflows.
	const reach = Math.max(0, ...dots.map((dot) => Math.abs(dot.offset))) + (more.length ? LANE : 0);
	return (
		<figure className="space-y-3 rounded-xl border bg-card px-5 pb-3 pt-4">
			<figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
				<span><span className="block font-medium sm:inline">{copy.when}</span><span className="hidden text-muted-foreground sm:inline"> · </span><span className="whitespace-nowrap text-muted-foreground">{copy.down(down, campaign.sites.length)}</span></span>
				<span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
					<span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full border-2 border-emerald-600" />{copy.takenDown}</span>
					<span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-red-600" />{copy.notTakenDown}</span>
				</span>
			</figcaption>
			<div ref={track} className="relative" style={{ height: DOT + 2 * reach + 8 }}>
				<div className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-border" />
				{dots.map(({ site, x, offset }) => {
					const isDown = site.takedown === "confirmed";
					const label = copy.dot(site.host, formatDate(site.firstSeenAt, locale), isDown);
					return (
						// Out of the tab order: the site list below is the keyboard path to the same sites.
						<button
							key={site.submissionId}
							type="button"
							tabIndex={-1}
							title={label}
							aria-label={label}
							onClick={() => onOpen(site)}
							className={cn(
								"absolute -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform before:absolute before:-inset-[5px] before:content-[''] hover:scale-125",
								isDown ? "border-2 border-emerald-600 bg-card" : "border-[3px] border-card bg-red-600 shadow-[0_0_0_1px_#fca5a5]",
							)}
							style={{ left: x, top: `calc(50% - ${offset}px)`, width: DOT, height: DOT }}
						/>
					);
				})}
				{more.map((spot) => {
					const label = copy.more(spot.sites.length, formatDate(spot.sites[0]!.firstSeenAt, locale));
					return (
						<button
							key={spot.sites[0]!.submissionId}
							type="button"
							tabIndex={-1}
							title={label}
							aria-label={label}
							onClick={() => onOpen(spot.sites[0]!)}
							className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border bg-background px-1.5 text-[11px] font-semibold leading-4 shadow-sm hover:bg-accent"
							style={{ left: spot.x, top: `calc(50% - ${reach}px)` }}
						>
							+{spot.sites.length}
						</button>
					);
				})}
			</div>
			<div className="flex justify-between text-xs text-muted-foreground">
				<span>{formatDate(start, locale)}</span>
				<span>{now === undefined ? "" : calendarDays(last, now) <= 0 ? copy.axisEnd : `${formatDate(now, locale)} (${copy.axisEnd})`}</span>
			</div>
		</figure>
	);
}
