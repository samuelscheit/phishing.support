import type { SubmissionCard } from "./list";

/** One tile of the public list: a single submission, or every loaded site of one campaign. */
export type SubmissionListItem =
	| { type: "submission"; key: string; submission: SubmissionCard }
	| { type: "campaign"; key: string; campaignId: string; newest: SubmissionCard; siteCount: number; titles: string[] };

/**
 * Collapse the sites of one campaign into one tile, placed where its newest
 * site would be. `siteCount` is the campaign's size, not only what is loaded.
 */
export function groupByCampaign(cards: readonly SubmissionCard[]): SubmissionListItem[] {
	const items: SubmissionListItem[] = [];
	const campaigns = new Map<string, Extract<SubmissionListItem, { type: "campaign" }>>();
	for (const card of cards) {
		if (!card.campaign) {
			items.push({ type: "submission", key: card.id, submission: card });
			continue;
		}
		const existing = campaigns.get(card.campaign.id);
		if (existing) {
			existing.titles.push(card.title);
			continue;
		}
		const item = { type: "campaign" as const, key: `campaign-${card.campaign.id}`, campaignId: card.campaign.id, newest: card, siteCount: card.campaign.siteCount, titles: [card.title] };
		campaigns.set(card.campaign.id, item);
		items.push(item);
	}
	return items;
}
