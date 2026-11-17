import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";

import { SiteFooter } from "@/components/SiteLayout";
import { CampaignRepository } from "@/lib/campaign/repository";
import { getPublicCampaign } from "@/lib/campaign/public_view";
import { CampaignView } from "./CampaignView";

export const dynamic = "force-dynamic";

async function campaignFor(id: string) {
	if (!/^\d{1,20}$/.test(id)) return undefined;
	return getPublicCampaign(BigInt(id));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
	const campaign = await campaignFor((await params).id);
	if (!campaign) return { title: "Campaign not found", robots: { index: false, follow: false } };
	return {
		title: campaign.title,
		description: campaign.summary,
		alternates: { canonical: `/campaigns/${campaign.campaignId}` },
		openGraph: { type: "article", url: `/campaigns/${campaign.campaignId}`, title: campaign.title, description: campaign.summary },
		robots: { index: true, follow: true },
	};
}

/**
 * The public page of one campaign: what it is, its pages with screenshots
 * and takedown history, why they are one operator's, and the full technical
 * record. Linked from the submission list and from criminal complaints.
 */
export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (/^\d{1,20}$/.test(id)) {
		const current = await CampaignRepository.currentCampaignId(BigInt(id));
		if (current !== undefined && current.toString() !== id) permanentRedirect(`/campaigns/${current.toString()}`);
	}
	const campaign = await campaignFor(id);
	if (!campaign) notFound();
	return (
		<>
			<main className="container mx-auto max-w-5xl space-y-6 px-4 py-10">
				<Link href="/" className="text-sm text-muted-foreground hover:text-foreground">← Phishing Support</Link>
				<CampaignView campaign={campaign} />
			</main>
			<SiteFooter />
		</>
	);
}
