/** Choices the campaign page makes from its data, shared by the server page and the client view. */
import type { PublicCampaign, PublicCampaignSite } from "@/lib/campaign/public_view";
import type { ReportedAs } from "@/lib/submissions/finding";
import type { Basis } from "./copy";

export type Finding = "phishing" | "malware";

/** What the sites were reported for: phishing, malware, or both when some are each. */
export function campaignReportedAs(campaign: PublicCampaign): ReportedAs {
	const findings = new Set(campaign.sites.map((site) => (site.verdict?.finding === "malware" ? "malware" : "phishing")));
	return findings.size > 1 ? "phishing_and_malware" : findings.has("malware") ? "malware" : "phishing";
}

/** What most of the sites are: the verdict's headline. */
export function findingOf(campaign: PublicCampaign): Finding {
	const malware = campaign.sites.filter((site) => site.verdict?.finding === "malware").length;
	return malware * 2 > campaign.sites.length ? "malware" : "phishing";
}

/** What most of the sites are after, by their verdicts. */
export function basisOf(campaign: PublicCampaign): Basis {
	const counts = { credentials: 0, payment: 0 };
	for (const site of campaign.sites) {
		if (site.verdict?.basis === "credential_theft") counts.credentials += 1;
		if (site.verdict?.basis === "payment_fraud") counts.payment += 1;
	}
	if (!counts.credentials && !counts.payment) return "other";
	return counts.payment > counts.credentials ? "payment" : "credentials";
}

/** The site whose picture stands for all: the newest with a usable capture that showed what it collects. */
export function representativeSite(campaign: PublicCampaign): PublicCampaignSite | undefined {
	const usable = campaign.sites.filter((site) => !site.blankCapture && (site.thumbnailUrl || site.screenshotUrl)).sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt));
	return usable.find((site) => site.sent.length && site.verdict?.fields.length) ?? usable[0];
}
