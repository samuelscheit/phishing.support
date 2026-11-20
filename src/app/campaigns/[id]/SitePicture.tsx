import type { PublicCampaignSite } from "@/lib/campaign/public_view";
import { Address } from "@/components/Address";
import { cn } from "@/lib/util/cn";

/** The picture of a site: its trimmed capture when there is one, else the full capture. */
function pictureOf(site: PublicCampaignSite): string | undefined {
	return site.blankCapture ? undefined : site.thumbnailUrl ?? site.screenshotUrl;
}

/**
 * A site's capture in a browser frame whose address bar shows only the
 * host, the part a visitor must learn to check (the case page's browser
 * shows the full address).
 */
export function BrowserFrame({ site, alt, className }: { site: PublicCampaignSite; alt: string; className?: string }) {
	const src = pictureOf(site);
	return (
		<div className={cn("overflow-hidden rounded-lg border bg-card shadow-sm", className)}>
			<div className="flex items-center gap-2 border-b bg-muted/60 px-3 py-2">
				<div className="flex gap-1" aria-hidden>
					{[0, 1, 2].map((dot) => <span key={dot} className="size-2.5 rounded-full bg-muted-foreground/30" />)}
				</div>
				<div className="min-w-0 flex-1 truncate rounded-md bg-background px-2.5 py-1 text-xs" title={site.url}>
					<Address url={site.url} bare />
				</div>
			</div>
			{/* eslint-disable-next-line @next/next/no-img-element */}
			{src && <img src={src} alt={alt} loading="lazy" className="block h-auto w-full bg-white" />}
		</div>
	);
}

/** A small preview in a list row, or a neutral box saying there is none. */
export function Thumb({ site, emptyLabel, className }: { site: PublicCampaignSite; emptyLabel: string; className?: string }) {
	const src = pictureOf(site);
	return (
		<div className={cn("relative aspect-[4/3] overflow-hidden rounded-md border bg-muted", className)}>
			{src
				// eslint-disable-next-line @next/next/no-img-element
				? <img src={src} alt="" loading="lazy" className="absolute inset-0 size-full bg-white object-cover object-left-top" />
				: <span className="absolute inset-0 flex items-center justify-center text-[11px] text-muted-foreground">{emptyLabel}</span>}
		</div>
	);
}
