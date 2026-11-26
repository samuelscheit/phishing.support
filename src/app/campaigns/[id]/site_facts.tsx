/** Small facts about one site, shown wherever the page names it. */
import type { PublicCampaignSite } from "@/lib/campaign/public_view";
import type { Locale } from "@/lib/i18n/locale";
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

/** Taken down once a provider confirmed it; until then reported but still online. */
export function TakedownPill({ site, locale }: { site: PublicCampaignSite; locale: Locale }) {
	const down = site.takedown === "confirmed";
	return (
		<span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", down ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800")}>
			<span className="size-1.5 rounded-full bg-current" />
			{down ? COPY[locale].takenDown : COPY[locale].notTakenDown}
		</span>
	);
}

/** Scrolls to an element without replacing the `#host` that names the visitor's site. */
export function scrollToId(id: string) {
	document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
