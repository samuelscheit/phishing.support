import type { SubmissionStatus } from "@/lib/db/schema";
import type { SubmissionCard } from "./list";

/**
 * One tile of the public list: a single submission, every loaded site of one
 * campaign, or the hosts of one site group (a registrable domain such as
 * slon10.to) that are in no campaign yet (queued, being visited, left out).
 */
export type SubmissionListItem =
	| { type: "submission"; key: string; submission: SubmissionCard }
	| {
		type: "campaign";
		key: string;
		campaignId: string;
		newest: SubmissionCard;
		siteCount: number;
		/** The site group every member's case is of, when they share one: the tile names it, with `hostCount`. */
		domain?: string;
		hostCount: number;
		titles: string[];
		/** The loaded cases of its domain still waiting for or in their visit, shown with the campaign. */
		pending: number;
	}
	| { type: "siteGroup"; key: string; siteGroup: string; newest: SubmissionCard; size: number; statuses: SubmissionStatus[] };

const PENDING: ReadonlySet<SubmissionStatus> = new Set(["queued", "running"]);

/**
 * Collapse the list into tiles, each placed where its newest card would be.
 * A campaign's sites are one tile; a case of a site group in no campaign
 * joins the tile of the campaign that group is (a host still queued beside
 * its reported domain), else the tile of its group when the group has more
 * than one case. Counts are the campaign's and the group's, not only what is
 * loaded.
 */
export function groupCards(cards: readonly SubmissionCard[]): SubmissionListItem[] {
	const campaignOfDomain = new Map<string, string>();
	for (const card of cards) if (card.campaign?.domain) campaignOfDomain.set(card.campaign.domain, card.campaign.id);

	const items: SubmissionListItem[] = [];
	const tiles = new Map<string, Exclude<SubmissionListItem, { type: "submission" }>>();
	const campaignTile = (card: SubmissionCard, campaign: NonNullable<SubmissionCard["campaign"]>) => {
		const key = `campaign-${campaign.id}`;
		const item = { type: "campaign" as const, key, campaignId: campaign.id, newest: card, siteCount: campaign.siteCount, hostCount: campaign.hostCount, titles: [] as string[], pending: 0, ...(campaign.domain ? { domain: campaign.domain } : {}) };
		tiles.set(key, item);
		items.push(item);
		return item;
	};
	for (const card of cards) {
		const domainCampaign = card.siteGroup && !card.campaign ? campaignOfDomain.get(card.siteGroup.key) : undefined;
		if (card.campaign || domainCampaign) {
			const key = `campaign-${card.campaign?.id ?? domainCampaign}`;
			const existing = tiles.get(key) as Extract<SubmissionListItem, { type: "campaign" }> | undefined;
			// A domain's waiting host may come before the campaign's own newest card; the campaign's numbers come from that card.
			const campaign = card.campaign ?? cards.find((other) => other.campaign?.id === domainCampaign)!.campaign!;
			const item = existing ?? campaignTile(card, campaign);
			if (card.campaign) item.titles.push(card.title);
			if (PENDING.has(card.status)) item.pending++;
			continue;
		}
		if (card.siteGroup && card.siteGroup.size > 1) {
			const key = `site-${card.siteGroup.key}`;
			const existing = tiles.get(key) as Extract<SubmissionListItem, { type: "siteGroup" }> | undefined;
			if (existing) {
				existing.statuses.push(card.status);
				continue;
			}
			const item = { type: "siteGroup" as const, key, siteGroup: card.siteGroup.key, newest: card, size: card.siteGroup.size, statuses: [card.status] };
			tiles.set(key, item);
			items.push(item);
			continue;
		}
		items.push({ type: "submission", key: card.id, submission: card });
	}
	return items;
}
