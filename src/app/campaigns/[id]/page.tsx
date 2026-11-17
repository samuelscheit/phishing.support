import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { Fingerprint, Network, Send, Wallet } from "lucide-react";

import { SiteFooter } from "@/components/SiteLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatUtcDateTime } from "@/lib/date_time";
import { CampaignRepository } from "@/lib/campaign/repository";
import { getPublicCampaign, type PublicCampaignLink } from "@/lib/campaign/public_view";

export const dynamic = "force-dynamic";

const LINK_ICON: Record<PublicCampaignLink["kind"], typeof Send> = {
	exfiltration_backend: Send,
	payment_receiver: Wallet,
	kit_fingerprint: Fingerprint,
	origin_ip: Network,
};

const TAKEDOWN_LABEL: Record<string, string> = {
	submitted: "reported",
	awaiting_provider_reply: "reported",
	acknowledged: "confirmed",
	provider_rejected: "rejected",
	delivery_failed: "not delivered",
	failed: "failed",
	no_route: "no route",
};

async function campaignFor(id: string) {
	if (!/^\d{1,20}$/.test(id)) return undefined;
	return getPublicCampaign(BigInt(id));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
	const campaign = await campaignFor((await params).id);
	if (!campaign) return { title: "Campaign not found", robots: { index: false, follow: false } };
	const title = `Phishing campaign with ${campaign.sites.length} sites`;
	const description = `${campaign.sites.length} phishing sites run by the same operator, first seen ${formatUtcDateTime(campaign.firstSeenAt)}, each captured and reported to its providers.`;
	return { title, description, alternates: { canonical: `/campaigns/${campaign.campaignId}` }, robots: { index: true, follow: true } };
}

/**
 * The public page of one campaign: every confirmed site the same operator
 * runs, what ties them together, and how far each takedown got. Linked from
 * the submission list and from criminal complaints.
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
			<main className="container mx-auto max-w-5xl space-y-8 px-4 py-10">
				<div className="space-y-2">
					<Link href="/" className="text-sm text-muted-foreground hover:text-foreground">← Phishing Support</Link>
					<h1 className="text-3xl font-bold tracking-tight">Phishing campaign {campaign.campaignId}</h1>
					<p className="text-muted-foreground">
						{campaign.sites.length} phishing sites run by the same operator, first seen {formatUtcDateTime(campaign.firstSeenAt)}, last seen {formatUtcDateTime(campaign.lastSeenAt)}
						{campaign.impersonates.length ? `, impersonating ${campaign.impersonates.join(", ")}` : ""}. Each site was captured as evidence and reported to its hosting, registrar and CDN providers.
					</p>
				</div>

				{campaign.links.length > 0 && (
					<section className="space-y-3">
						<h2 className="text-xl font-semibold">What ties the sites together</h2>
						<Card>
							<CardContent className="divide-y p-0">
								{campaign.links.map((link) => {
									const Icon = LINK_ICON[link.kind];
									return (
										<div key={link.label} className="flex items-start gap-3 px-4 py-3">
											<Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
											<span className="min-w-0 flex-1 break-words text-sm">{link.label}</span>
											<Badge variant="secondary" className="shrink-0">{link.siteCount} sites</Badge>
										</div>
									);
								})}
							</CardContent>
						</Card>
					</section>
				)}

				<section className="space-y-3">
					<h2 className="text-xl font-semibold">Sites</h2>
					<Card>
						<CardContent className="divide-y p-0">
							{campaign.sites.map((site) => (
								<Link key={site.submissionId} href={`/submissions/${site.submissionId}`} className="block space-y-1 px-4 py-3 transition-colors hover:bg-accent">
									<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
										<span className="min-w-0 break-all font-mono text-sm">{site.url}</span>
										<span className="text-xs text-muted-foreground">{formatUtcDateTime(site.firstSeenAt)}</span>
									</div>
									{site.takedown.length > 0 && (
										<p className="text-xs text-muted-foreground">
											{site.takedown.map((report) => `${report.provider}: ${TAKEDOWN_LABEL[report.status] ?? report.status.replaceAll("_", " ")}`).join(" · ")}
										</p>
									)}
								</Link>
							))}
						</CardContent>
					</Card>
				</section>
			</main>
			<SiteFooter />
		</>
	);
}
