"use client";

/**
 * The public page of one campaign, written for a visitor who found one of its
 * sites: the verdict first, then what they may have given away and what to
 * do, how to recognise the sites, every site with its takedown state, and the
 * full technical record collapsed at the foot for investigators. A `#host`
 * link names the visitor's site at the top and opens it in the list.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, ArrowDown } from "lucide-react";

import type { PublicCampaign, PublicCampaignSite } from "@/lib/campaign/public_view";
import type { Locale } from "@/lib/i18n";
import { COPY } from "./copy";
import { Recognise } from "./Recognise";
import { SiteList, scrollToId } from "./SiteList";
import { InvestigatorSection } from "./TechnicalRecord";
import { ActiveLine, Timeline } from "./Timeline";
import { basisOf, representativeSite } from "./visitor";
import { WhatToDo } from "./WhatToDo";

/** Fake addresses shown under "How to recognise them": enough to learn from, never a wall. */
const MAX_FAKES = 4;

/** The visitor's site from a `#host` link; read after mount, since the server never sees the hash. */
function useLinkedSite(sites: PublicCampaignSite[]): PublicCampaignSite | undefined {
	const [site, setSite] = useState<PublicCampaignSite>();
	useEffect(() => {
		const read = () => {
			// A truncated shared link can carry a malformed escape; it must name no site, never break the page.
			let host = window.location.hash.slice(1);
			try {
				host = decodeURIComponent(host);
			} catch {
				// Keep the raw value.
			}
			setSite(sites.find((candidate) => candidate.host === host.toLowerCase()));
		};
		read();
		window.addEventListener("hashchange", read);
		return () => window.removeEventListener("hashchange", read);
	}, [sites]);
	return site;
}

export function CampaignView({ campaign, locale }: { campaign: PublicCampaign; locale: Locale }) {
	const copy = COPY[locale];
	const { brand } = campaign.visitor;
	const n = campaign.sites.length;
	const linked = useLinkedSite(campaign.sites);
	const [focus, setFocus] = useState<{ id: string; at: number }>();
	const representative = representativeSite(campaign);
	const linkedShows = linked && !linked.blankCapture && (linked.thumbnailUrl || linked.screenshotUrl);
	const shown = linkedShows ? linked : representative;
	const caption = shown ? (linked && !linkedShows ? copy.shotCaptionMissing(linked.host, shown.host) : copy.shotCaption(shown.host)) : "";
	// The fake addresses to learn from: the visitor's own, the one in the picture, and a few that carry the brand's name and so look trustworthy.
	const letters = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
	const carriesBrand = (site: PublicCampaignSite) => Boolean(brand && letters(brand.name).length > 2 && letters(site.host).includes(letters(brand.name)));
	const fakes = [...new Set([linked, shown, ...campaign.sites.filter(carriesBrand)].filter((site): site is PublicCampaignSite => Boolean(site)))].slice(0, MAX_FAKES);
	const basis = basisOf(campaign);

	return (
		<div className="space-y-14">
			<header className="space-y-4">
				{linked && (
					<div className="mb-8 space-y-2 rounded-lg bg-red-600 px-4 py-3 text-white">
						<p className="flex items-start gap-2 font-semibold"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{copy.hostBanner(linked.host)}</p>
						<div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-6 text-sm">
							<button type="button" onClick={() => scrollToId("what-to-do")} className="inline-flex min-h-10 items-center gap-1 rounded-md bg-white px-3 font-semibold text-red-700 hover:bg-red-50">{copy.hostBannerSteps}<ArrowDown className="size-3.5" /></button>
							<button type="button" onClick={() => scrollToId(`site-${linked.submissionId}`)} className="inline-flex min-h-10 items-center gap-1 underline underline-offset-2">{copy.hostBannerList}<ArrowDown className="size-3.5" /></button>
						</div>
					</div>
				)}
				<h1 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">{copy.headline(brand?.name, basis, campaign.title)}</h1>
				<div className="max-w-3xl space-y-1 text-lg">
					<p className="font-semibold">{copy.verdict(n)}</p>
					<p className="text-pretty text-muted-foreground">{copy.lede(n, brand?.name, basis)}</p>
				</div>
				<ActiveLine campaign={campaign} locale={locale} />
				<p className="text-sm text-muted-foreground">{copy.trust(brand?.name)}</p>
			</header>

			<WhatToDo visitor={campaign.visitor} basis={basis} locale={locale} shown={shown} caption={caption} />

			{brand && <Recognise brand={brand} fakes={fakes} locale={locale} />}

			<section className="space-y-4">
				<div className="max-w-3xl space-y-1">
					<h2 className="text-xl font-semibold tracking-tight sm:text-2xl">{copy.sites(n)}</h2>
					<p className="text-pretty text-muted-foreground">{copy.sitesSub}</p>
				</div>
				{n > 1 && <Timeline campaign={campaign} locale={locale} onOpen={(site) => setFocus({ id: site.submissionId, at: Date.now() })} />}
				<SiteList campaign={campaign} locale={locale} linkedHost={linked?.host} focus={focus} />
			</section>

			<InvestigatorSection campaign={campaign} locale={locale} />
		</div>
	);
}
