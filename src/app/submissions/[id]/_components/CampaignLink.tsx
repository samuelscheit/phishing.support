import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { COPY as CAMPAIGN_COPY } from "@/app/campaigns/[id]/copy";
import type { Locale } from "@/lib/i18n/locale";
import type { SubmissionDetail } from "@/lib/submissions/details";

/**
 * The way from a case to its campaign's page, which tells a visitor what to do
 * and lists the group's other sites; `#host` makes that page name this site.
 */
export function CampaignLink({ campaign, host, locale }: { campaign: NonNullable<SubmissionDetail["campaign"]>; host?: string; locale: Locale }) {
	const copy = CAMPAIGN_COPY[locale];
	return (
		<section lang={locale} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
			<p className="min-w-0 text-sm font-semibold">{copy.caseCard(campaign.siteCount)}</p>
			<Link href={`/campaigns/${campaign.id}?lang=${locale}${host ? `#${host}` : ""}`} className="inline-flex shrink-0 items-center gap-2 rounded-xl border bg-background px-4 py-2.5 text-sm font-medium shadow-sm transition-colors hover:bg-accent">
				{copy.caseCardButton(campaign.siteCount)}<ArrowRight className="size-4" />
			</Link>
		</section>
	);
}
