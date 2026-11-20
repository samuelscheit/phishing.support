import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CampaignRepository } from "@/lib/campaign/repository";
import { formatUtcDateTime } from "@/lib/date_time";
import { RebuildCampaignsButton } from "./RebuildCampaignsButton";

export const dynamic = "force-dynamic";

const INDICATOR_LABEL: Record<string, string> = {
	operator_server: "operator server",
	payment_receiver: "payment receiver",
	delivery_command: "delivery command",
	kit_fingerprint: "kit file",
};

export default async function CampaignsPage() {
	const campaigns = await CampaignRepository.listCampaigns();
	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-end justify-between gap-4">
				<div className="space-y-1">
					<h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
					<p className="text-sm text-muted-foreground">Confirmed sites grouped by a data drop, payment receiver or kit file only one operator has.</p>
				</div>
				<RebuildCampaignsButton />
			</div>
			{campaigns.length === 0 ? (
				<Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No campaign yet. Sites join one once their report is resolved.</CardContent></Card>
			) : (
				<div className="grid gap-3">
					{campaigns.map((summary) => (
						<Link key={summary.campaign.id.toString()} href={`/operator/campaigns/${summary.campaign.id.toString()}`} className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
							<Card className="transition-colors hover:border-primary/40">
								<CardHeader className="gap-1 pb-2">
									<CardTitle className="flex flex-wrap items-center gap-2 text-base">
										Campaign {summary.campaign.id.toString()}
										<Badge variant="secondary">{summary.memberCount} {summary.memberCount === 1 ? "site" : "sites"}</Badge>
										{Object.entries(summary.linkingIndicators).map(([kind, count]) => (
											<Badge key={kind} variant="outline">{count} {INDICATOR_LABEL[kind] ?? kind}{count === 1 ? "" : "s"}</Badge>
										))}
									</CardTitle>
									<CardDescription>
										{formatUtcDateTime(summary.firstSeenAt)} – {formatUtcDateTime(summary.lastSeenAt)}
									</CardDescription>
								</CardHeader>
								<CardContent className="space-y-1 pt-0">
									{summary.sampleUrls.map((url) => <p key={url} className="truncate font-mono text-xs text-muted-foreground">{url}</p>)}
								</CardContent>
							</Card>
						</Link>
					))}
				</div>
			)}
		</div>
	);
}
