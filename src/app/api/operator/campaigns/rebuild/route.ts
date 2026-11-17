import { rebuildCampaigns } from "@/lib/campaign/link";
import { operatorHandler } from "@/lib/referral/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let running: Promise<unknown> | undefined;

/**
 * Extract every confirmed site's indicators again and regroup all campaigns.
 * It reads every capture, so it runs in the background; a second request
 * while it runs is answered with the running state.
 */
export async function POST(request: Request) {
	return operatorHandler(request, async () => {
		if (running) return Response.json({ state: "running" }, { status: 202 });
		running = rebuildCampaigns()
			.then((result) => console.log(`Campaign rebuild linked ${result.linked} sites and described ${result.described} campaigns; ${result.failed.length} failed.`, result.failed.slice(0, 20)))
			.catch((error) => console.error("Campaign rebuild failed:", error))
			.finally(() => { running = undefined; });
		return Response.json({ state: "started" }, { status: 202 });
	});
}
