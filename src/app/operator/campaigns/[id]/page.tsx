import { notFound, redirect } from "next/navigation";

import { getCampaignOverview } from "@/lib/referral/overview";
import { CampaignPageClient } from "./CampaignPageClient";

export const dynamic = "force-dynamic";

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!/^\d{1,20}$/.test(id)) notFound();
	const overview = await getCampaignOverview(BigInt(id));
	if (!overview) notFound();
	if (overview.mergedInto && overview.mails.length === 0) redirect(`/operator/campaigns/${overview.mergedInto}`);
	return <CampaignPageClient overview={overview} />;
}
