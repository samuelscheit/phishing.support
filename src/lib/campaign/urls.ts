import { serviceIdentity } from "../network/service_identity";

/** The public page listing every site of a campaign. */
export function publicCampaignUrl(campaignId: bigint | string): string {
	return `${serviceIdentity.url}/campaigns/${campaignId.toString()}`;
}

/** The public archive of a campaign's dossier and every evidence file. */
export function publicEvidenceUrl(campaignId: bigint | string): string {
	return `${publicCampaignUrl(campaignId)}/evidence.zip`;
}
