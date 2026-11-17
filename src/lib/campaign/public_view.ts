import { buildDossier, type DossierDependencies, type DossierIndicator } from "../referral/dossier";
import { CampaignRepository } from "./repository";

/**
 * What the public campaign page shows: every site with its takedown state
 * and what links the sites. It is the authority's dossier without what must
 * stay with the authority: a bot's token and chat (anyone could take over or
 * spam the bot, and the operator would learn it is known), a payment account
 * (it often belongs to a mule who is a victim too), the server addresses and
 * the evidence files.
 */
export type PublicCampaignSite = {
	submissionId: string;
	url: string;
	firstSeenAt: string;
	takedown: Array<{ provider: string; status: string }>;
};

export type PublicCampaignLink = { kind: DossierIndicator["kind"]; label: string; siteCount: number };

export type PublicCampaign = {
	campaignId: string;
	firstSeenAt: string;
	lastSeenAt: string;
	impersonates: string[];
	sites: PublicCampaignSite[];
	links: PublicCampaignLink[];
};

function publicLabel(indicator: DossierIndicator): string {
	if (indicator.kind === "exfiltration_backend") {
		if (indicator.evidence.backendKind === "telegram_bot") return "The same Telegram bot receives what visitors enter";
		if (indicator.evidence.backendKind === "discord_webhook") return "The same Discord webhook receives what visitors enter";
		return `The same collector host receives what visitors enter: ${indicator.value.replace(/^collector-host:/, "")}`;
	}
	if (indicator.kind === "payment_receiver") return "The same payment account is named to visitors";
	return `The same kit file (SHA-256 ${indicator.value})`;
}

/** The public view of a campaign, or undefined when it has no sites (merged or emptied). */
export async function getPublicCampaign(campaignId: bigint, dependencies: DossierDependencies = {}): Promise<PublicCampaign | undefined> {
	if (!await CampaignRepository.getCampaign(campaignId)) return undefined;
	const dossier = await buildDossier(campaignId, dependencies);
	if (!dossier.sites.length) return undefined;
	return {
		campaignId: dossier.campaignId,
		firstSeenAt: dossier.firstSeenAt,
		lastSeenAt: dossier.lastSeenAt,
		impersonates: dossier.impersonates,
		sites: dossier.sites.map((site) => ({
			submissionId: site.submissionId,
			url: site.url,
			firstSeenAt: site.firstSeenAt,
			takedown: site.reports.map((report) => ({ provider: report.provider, status: report.status })),
		})),
		links: dossier.indicators
			.filter((indicator) => indicator.links && indicator.sites.length > 1)
			.map((indicator) => ({ kind: indicator.kind, label: publicLabel(indicator), siteCount: indicator.sites.length })),
	};
}
