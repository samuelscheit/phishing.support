import { z } from "zod";

import { operatorHandler, parseId } from "@/lib/referral/http";
import { approveReferralMail, discardReferralMail, saveReferralDraft, setReferralCaseReference } from "@/lib/referral/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const draft = { subject: z.string().min(1).max(400), body: z.string().min(1).max(20_000) };
const bodySchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("save"), ...draft }),
	z.object({ action: z.literal("approve"), ...draft }),
	z.object({ action: z.literal("discard") }),
	z.object({ action: z.literal("case_reference"), caseReference: z.string().max(60).nullable() }),
]);

/** Edit, approve or discard one drafted referral mail, or set its authority's file number. */
export async function POST(request: Request, { params }: { params: Promise<{ routeId: string }> }) {
	return operatorHandler(request, async () => {
		const routeId = parseId((await params).routeId);
		const body = bodySchema.safeParse(await request.json().catch(() => undefined));
		if (routeId === undefined || !body.success) return Response.json({ error: "Invalid request." }, { status: 400 });
		const action = body.data;
		if (action.action === "save") await saveReferralDraft(routeId, action);
		else if (action.action === "approve") await approveReferralMail(routeId, action);
		else if (action.action === "discard") await discardReferralMail(routeId);
		else await setReferralCaseReference(routeId, action.caseReference?.trim() ? action.caseReference : null);
		return Response.json({ ok: true });
	});
}
