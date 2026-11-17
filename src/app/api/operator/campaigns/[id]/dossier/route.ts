import { dossierArchive } from "@/lib/referral/archive";
import { buildReferralDossier } from "@/lib/referral/dossier";
import { operatorHandler, parseId, zipResponse } from "@/lib/referral/http";
import { CampaignRepository } from "@/lib/campaign/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The campaign's dossier with every evidence file, for the operator. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
	return operatorHandler(request, async () => {
		const campaignId = parseId((await params).id);
		if (campaignId === undefined || !await CampaignRepository.getCampaign(campaignId)) return new Response("Not found", { status: 404 });
		return zipResponse(dossierArchive(await buildReferralDossier(campaignId)), `phishing-kampagne-${campaignId.toString()}.zip`);
	});
}
