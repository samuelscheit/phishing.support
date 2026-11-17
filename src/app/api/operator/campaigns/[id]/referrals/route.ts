import { z } from "zod";

import { operatorHandler, parseId } from "@/lib/referral/http";
import { prepareComplaint, preparePreservationNotices, prepareSupplement } from "@/lib/referral/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("complaint"), authorityId: z.string().min(1).max(60) }),
	z.object({ action: z.literal("supplement"), authorityId: z.string().min(1).max(60) }),
	z.object({ action: z.literal("preservation") }),
]);

/** Draft a referral mail for the campaign; nothing is sent until the mail is approved. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	return operatorHandler(request, async () => {
		const campaignId = parseId((await params).id);
		const body = bodySchema.safeParse(await request.json().catch(() => undefined));
		if (campaignId === undefined || !body.success) return Response.json({ error: "Invalid request." }, { status: 400 });
		const action = body.data;
		const routes = action.action === "complaint"
			? [await prepareComplaint(campaignId, action.authorityId)]
			: action.action === "supplement"
				? [await prepareSupplement(campaignId, action.authorityId)]
				: await preparePreservationNotices(campaignId);
		return Response.json({ routeIds: routes.map((route) => route.id.toString()) }, { status: 201 });
	});
}
