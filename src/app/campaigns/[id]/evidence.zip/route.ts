import { CampaignRepository } from "@/lib/campaign/repository";
import { buildDossierArchive } from "@/lib/referral/archive";
import { buildReferralDossier } from "@/lib/referral/dossier";
import { zipResponse } from "@/lib/referral/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The public evidence archive of a campaign: the same dossier and files the
 * authorities get. What the operators published on their pages (bot tokens,
 * accounts) is published here as it was found.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const current = /^\d{1,20}$/.test(id) ? await CampaignRepository.currentCampaignId(BigInt(id)) : undefined;
	if (current === undefined) return new Response("Not found", { status: 404 });
	const dossier = await buildReferralDossier(current);
	if (!dossier.sites.length) return new Response("Not found", { status: 404 });
	return zipResponse(await buildDossierArchive(dossier), `phishing-campaign-${current.toString()}.zip`);
}
