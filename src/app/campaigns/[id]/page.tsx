import type { Metadata } from "next";
import { cache } from "react";
import { notFound, permanentRedirect } from "next/navigation";

import { SiteFooter } from "@/components/SiteLayout";
import { CampaignRepository } from "@/lib/campaign/repository";
import { getPublicCampaign, type PublicCampaign } from "@/lib/campaign/public_view";
import { LOCALES, type Locale } from "@/lib/i18n/locale";
import { requestLocale } from "@/lib/i18n/server";
import { COPY } from "./copy";
import { CampaignView } from "./CampaignView";
import { basisOf } from "./visitor";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Built once per request: the metadata and the page share it. */
const campaignFor = cache(async (id: string) => {
	if (!/^\d{1,20}$/.test(id)) return undefined;
	return getPublicCampaign(BigInt(id));
});

/** Newest sites first: the ones a visitor most likely searched for. */
function hostsOf(campaign: PublicCampaign): string[] {
	return [...campaign.sites].sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt)).map((site) => site.host);
}

function headlineOf(campaign: PublicCampaign, locale: Locale): string {
	return COPY[locale].headline(campaign.visitor.brand?.name, basisOf(campaign), campaign.title);
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
	const campaign = await campaignFor((await params).id);
	if (!campaign) return { title: "Campaign not found", robots: { index: false, follow: false } };
	const locale = await requestLocale((await searchParams).lang);
	const copy = COPY[locale];
	const hosts = hostsOf(campaign);
	const title = copy.metaTitle(headlineOf(campaign, locale), hosts);
	const description = copy.metaDescription(hosts, copy.verdict(campaign.sites.length));
	const path = `/campaigns/${campaign.campaignId}`;
	return {
		title,
		description,
		// Each language is its own canonical page; the bare address picks one by the visitor's browser.
		alternates: { canonical: `${path}?lang=${locale}`, languages: { ...Object.fromEntries(LOCALES.map((code) => [code, `${path}?lang=${code}`])), "x-default": path } },
		openGraph: { type: "article", url: path, title, description, locale: locale === "de" ? "de_DE" : "en_GB" },
		robots: { index: true, follow: true },
	};
}

/**
 * The public page of one campaign, for a visitor who found one of its sites.
 * Linked from each case page (with `#host`), the submission list and
 * criminal complaints.
 */
export default async function CampaignPage({ params, searchParams }: Props) {
	const { id } = await params;
	const { lang } = await searchParams;
	if (/^\d{1,20}$/.test(id)) {
		const current = await CampaignRepository.currentCampaignId(BigInt(id));
		if (current !== undefined && current.toString() !== id) permanentRedirect(`/campaigns/${current.toString()}${typeof lang === "string" ? `?lang=${encodeURIComponent(lang)}` : ""}`);
	}
	const campaign = await campaignFor(id);
	if (!campaign) notFound();
	const locale = await requestLocale(lang);
	return (
		<>
			<main lang={locale} className="container mx-auto max-w-7xl px-4 py-8">
				<CampaignView campaign={campaign} locale={locale} />
			</main>
			<SiteFooter />
		</>
	);
}
