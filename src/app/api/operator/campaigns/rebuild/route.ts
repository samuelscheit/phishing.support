import { enqueueCampaignSweep } from "@/lib/campaign/sweep";
import { operatorHandler } from "@/lib/referral/http";
import { utcDate } from "@/lib/util/date_time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Link every confirmed site again, as jobs: each site's kit files, its
 * campaign, its description and its campaign's kit search. At most one
 * sweep a day: another request that day queues nothing new.
 */
export async function POST(request: Request) {
	return operatorHandler(request, async () => {
		const sites = await enqueueCampaignSweep(`manual-${utcDate(new Date())}`);
		return Response.json({ state: "queued", sites }, { status: 202 });
	});
}
