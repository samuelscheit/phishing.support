/** Small facts about one site, shown wherever the page names it. */
import type { PublicCampaignSite, SiteTakedown } from "@/lib/campaign/public_view";
import type { Locale } from "@/lib/i18n/locale";
import { hostMoveText } from "@/lib/liveness/moves";
import { cn } from "@/lib/util/cn";
import { COPY } from "./copy";

/** "Dutch" for `nl`, in the page's language; nothing for an unknown code. */
export function languageName(code: string | undefined, locale: Locale): string | undefined {
	if (!code) return undefined;
	try {
		return new Intl.DisplayNames([locale], { type: "language" }).of(code);
	} catch {
		return undefined;
	}
}

/** The takedown states from settled to most dangerous, the order every legend and filter lists them in. */
export const TAKEDOWN_ORDER: readonly SiteTakedown[] = ["taken_down", "blocklisted", "reported", "problem", "none"];

/** Each state's colours: its pill, its dot (strip, timeline, legend) and its share of the takedown bar. */
export const TAKEDOWN_STYLE: Record<SiteTakedown, { pill: string; dot: string }> = {
	taken_down: { pill: "border-emerald-200 bg-emerald-50 text-emerald-800", dot: "bg-emerald-500" },
	blocklisted: { pill: "border-amber-200 bg-amber-50 text-amber-800", dot: "bg-amber-500" },
	reported: { pill: "border-red-200 bg-red-50 text-red-800", dot: "bg-red-500" },
	problem: { pill: "border-zinc-300 bg-zinc-50 text-zinc-700", dot: "bg-zinc-500" },
	none: { pill: "border-zinc-200 bg-background text-zinc-600", dot: "bg-zinc-300" },
};

/** Where the takedown of a site stands: taken down, blocklisted but up, reported, or not reported. */
export function TakedownPill({ site, locale }: { site: PublicCampaignSite; locale: Locale }) {
	return (
		<span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", TAKEDOWN_STYLE[site.takedown].pill)}>
			<span className="size-1.5 rounded-full bg-current" />
			{COPY[locale].takedownState[site.takedown]}
		</span>
	);
}

/** Where a reported site moved and still serves, in the words the case page uses; nothing for a site that did not move. */
export function MovedNote({ site, locale, className }: { site: PublicCampaignSite; locale: Locale; className?: string }) {
	if (!site.moved) return null;
	return <p className={cn("text-xs font-medium text-orange-700", className)}>{hostMoveText(site.moved, site.moved.allegation, locale)}</p>;
}

/** How many sites are in each state, for the states any site is in, in `TAKEDOWN_ORDER`. */
export function takedownCounts(sites: readonly PublicCampaignSite[]): Array<{ state: SiteTakedown; count: number }> {
	return TAKEDOWN_ORDER.map((state) => ({ state, count: sites.filter((site) => site.takedown === state).length })).filter(({ count }) => count > 0);
}

/** Scrolls to an element without replacing the `#host` that names the visitor's site. */
export function scrollToId(id: string) {
	document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
