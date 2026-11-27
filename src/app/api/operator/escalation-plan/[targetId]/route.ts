import { z } from "zod";

import { sendEscalationStepNow, skipEscalationStep } from "@/lib/abuse/escalation/manual";
import { operatorHandler, parseId } from "@/lib/http/operator_handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
	/** The step's key on the target's ladder: `route:<id>:<level>` or `site:<level>`. */
	step: z.string().regex(/^(?:route:\d{1,20}:[1-5]|site:[1-5])$/),
	action: z.enum(["send_now", "skip"]),
});

/** Take a planned escalation step of the target now, or skip it. */
export async function POST(request: Request, { params }: { params: Promise<{ targetId: string }> }) {
	return operatorHandler(request, async () => {
		const targetId = parseId((await params).targetId);
		const body = bodySchema.safeParse(await request.json().catch(() => undefined));
		if (targetId === undefined || !body.success) return Response.json({ error: "Invalid request." }, { status: 400 });
		await (body.data.action === "send_now" ? sendEscalationStepNow : skipEscalationStep)(targetId, body.data.step);
		return Response.json({ ok: true });
	});
}
