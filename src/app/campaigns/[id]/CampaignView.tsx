"use client";

/**
 * The public page of one campaign, laid out as a case page: the header with
 * the verdict badge, the warning a visitor must see, then the sites in a
 * browser frame with the record in tabs, beside the verdict, the takedown
 * and what to do. On a phone the side column comes first. A `#host` link
 * names the visitor's site in the warning and opens it in the browser.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowDown, Layers } from "lucide-react";

import { LanguageSwitch } from "@/components/LanguageSwitch";
import { SubmissionStatus } from "@/components/SubmissionStatus";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { PublicCampaign, PublicCampaignSite } from "@/lib/campaign/public_view";
import { formatDate, type Locale } from "@/lib/i18n/locale";
import { cn } from "@/lib/util/cn";
import { COPY } from "./copy";
import { TakedownCard, VerdictCard } from "./Outcome";
import { Reasons } from "./Reasons";
import { scrollToId } from "./site_facts";
import { SiteBrowser } from "./SitePicture";
import { SiteTable } from "./SiteTable";
import { EvidenceRecord, TechnicalRecord } from "./TechnicalRecord";
import { ActiveBadge, Timeline } from "./Timeline";
import { basisOf, campaignReportedAs, findingOf, representativeSite } from "./visitor";
import { WhatToDo } from "./WhatToDo";

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
	// Newest first: the sites a visitor most likely came from.
	const [sites] = useState(() => [...campaign.sites].sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt)));
	const n = sites.length;
	const linked = useLinkedSite(sites);
	const [picked, setPicked] = useState<PublicCampaignSite>();
	const [tab, setTab] = useState("sites");
	useEffect(() => setPicked(linked), [linked]);
	const shown = picked ?? linked ?? representativeSite(campaign) ?? sites[0]!;
	const basis = basisOf(campaign);
	const headline = copy.headline(brand?.name, basis, campaign.title);
	const languages = new Set(sites.map((site) => site.language).filter(Boolean)).size;
	const openSite = (site: PublicCampaignSite) => {
		setPicked(site);
		scrollToId("site-browser");
	};

	return (
		<div className="space-y-6">
			<header className="space-y-3">
				<div className="flex items-center justify-between gap-4">
					<nav className="flex min-w-0 items-center gap-2 text-sm" aria-label="Breadcrumb">
						<Link href="/" className="shrink-0 text-muted-foreground hover:underline">{copy.back}</Link>
						<span className="text-muted-foreground">/</span>
						<span className="truncate font-medium">{headline}</span>
					</nav>
					<LanguageSwitch locale={locale} />
				</div>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="min-w-0 space-y-1">
						<h1 className="flex items-center gap-2 text-balance text-xl font-semibold leading-tight tracking-tight sm:text-2xl">
							<Layers className="size-6 shrink-0 text-muted-foreground" />
							<span className="min-w-0">{headline}</span>
						</h1>
						<p className="text-sm text-muted-foreground">{copy.facts(n, campaign.platform, languages)}</p>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">{formatDate(campaign.firstSeenAt, locale)}{campaign.firstSeenAt.slice(0, 10) !== campaign.lastSeenAt.slice(0, 10) ? ` – ${formatDate(campaign.lastSeenAt, locale)}` : ""}</Badge>
						<ActiveBadge campaign={campaign} locale={locale} />
						<SubmissionStatus status="reported" reportedAs={campaignReportedAs(campaign)} />
					</div>
				</div>
			</header>

			<section className={cn("flex flex-wrap items-center justify-between gap-3 rounded-lg px-4 py-3", linked ? "bg-red-600 text-white" : "border border-destructive/30 bg-destructive/5")}>
				<div className="min-w-0">
					<p className="flex items-start gap-2 font-semibold">{linked && <AlertTriangle className="mt-1 size-4 shrink-0" />}{linked ? copy.hostBanner(linked.host) : copy.verdict(n)}</p>
					<p className={cn("text-xs", linked ? "text-white/85" : "text-muted-foreground")}>{copy.trust(brand?.name)}</p>
				</div>
				<button type="button" onClick={() => scrollToId("what-to-do")} className={cn("inline-flex min-h-10 shrink-0 items-center gap-2 rounded-xl border px-4 py-2 text-sm font-medium shadow-sm transition-colors", linked ? "border-white bg-white text-red-700 hover:bg-red-50" : "bg-background hover:bg-accent")}>
					{copy.whatToDoButton}<ArrowDown className="size-4" />
				</button>
			</section>

			<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
				<div className="min-w-0 space-y-6">
					<SiteBrowser sites={sites} selected={shown} onSelect={setPicked} linkedHost={linked?.host} locale={locale} />
					<Tabs value={tab} onValueChange={setTab} className="w-full min-w-0">
						<TabsList className="h-auto max-w-full flex-wrap justify-start">
							<TabsTrigger value="sites">{copy.tabSites(n)}</TabsTrigger>
							{n > 1 && <TabsTrigger value="timeline">{copy.tabTimeline}</TabsTrigger>}
							{campaign.reasons.length > 0 && <TabsTrigger value="links">{copy.tabLinks}</TabsTrigger>}
							<TabsTrigger value="technical">{copy.tabTechnical}</TabsTrigger>
							<TabsTrigger value="evidence">{copy.tabEvidence}</TabsTrigger>
						</TabsList>
						<TabsContent value="sites" className="mt-4">
							<SiteTable sites={sites} selected={shown} onSelect={setPicked} linkedHost={linked?.host} brandDomain={brand?.domain} locale={locale} />
						</TabsContent>
						{n > 1 && (
							<TabsContent value="timeline" className="mt-4">
								<Timeline campaign={campaign} locale={locale} onOpen={openSite} />
							</TabsContent>
						)}
						{campaign.reasons.length > 0 && (
							<TabsContent value="links" className="mt-4">
								<Reasons campaign={campaign} locale={locale} />
							</TabsContent>
						)}
						<TabsContent value="technical" className="mt-4">
							<TechnicalRecord campaign={campaign} locale={locale} />
						</TabsContent>
						<TabsContent value="evidence" className="mt-4">
							<EvidenceRecord campaign={campaign} locale={locale} />
						</TabsContent>
					</Tabs>
				</div>
				<aside className="order-first min-w-0 space-y-4 lg:order-none">
					<VerdictCard campaign={campaign} finding={findingOf(campaign)} basis={basis} shown={shown} locale={locale} />
					<TakedownCard sites={sites} locale={locale} />
					<WhatToDo visitor={campaign.visitor} basis={basis} locale={locale} />
				</aside>
			</div>
		</div>
	);
}
