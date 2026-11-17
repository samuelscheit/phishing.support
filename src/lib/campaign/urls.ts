import { serviceIdentity } from "../constants";

/** The public page listing every site of a campaign. */
export function publicCampaignUrl(campaignId: bigint | string): string {
	return `${serviceIdentity.url}/campaigns/${campaignId.toString()}`;
}
