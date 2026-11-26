import type { PublicCampaign } from "@/lib/campaign/public_view";
import type { Locale } from "@/lib/i18n/locale";
import { COPY } from "./copy";

/** Why the sites are one operator's: each shared trait with how many of the sites show it. */
export function Reasons({ campaign, locale }: { campaign: PublicCampaign; locale: Locale }) {
	const copy = COPY[locale];
	const n = campaign.sites.length;
	return (
		<div className="space-y-3">
			<p className="text-sm text-muted-foreground">{copy.linksSub}</p>
			<ul className="grid gap-3 sm:grid-cols-2">
				{campaign.reasons.map((reason) => (
					<li key={reason.kind} className="rounded-lg border bg-card p-4">
						<div className="flex items-baseline justify-between gap-2">
							<p className="text-sm font-semibold">{reason.title}</p>
							<p className="shrink-0 text-xs tabular-nums text-muted-foreground">{copy.ofSites(reason.sites, n)}</p>
						</div>
						<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden><div className="h-full bg-foreground/80" style={{ width: `${(reason.sites / n) * 100}%` }} /></div>
						<p className="mt-2 text-pretty text-xs text-muted-foreground">{reason.text}</p>
					</li>
				))}
			</ul>
		</div>
	);
}
