import { CampaignRepository } from "@/lib/campaign/repository";
import { buildDossierArchive } from "@/lib/referral/archive";
import { buildDossier } from "@/lib/referral/dossier";
import { verifyDossierToken } from "@/lib/referral/download_link";
import { zipResponse } from "@/lib/referral/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The evidence archive an authority opens from a referral mail. The signed,
 * expiring token in the link is the only credential; a merged campaign's
 * link still opens the campaign it was merged into.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
	let campaignId: bigint | undefined;
	try {
		campaignId = verifyDossierToken((await params).token);
	} catch {
		campaignId = undefined;
	}
	const current = campaignId === undefined ? undefined : await CampaignRepository.currentCampaignId(campaignId);
	if (current === undefined) return new Response("Dieser Link ist ungültig oder abgelaufen.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
	const archive = await buildDossierArchive(await buildDossier(current));
	return zipResponse(archive, `phishing-kampagne-${current.toString()}.zip`);
}
