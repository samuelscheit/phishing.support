import { z } from "zod";

import { resolveEscalationStep } from "@/lib/abuse/escalation/manual";
import { operatorHandler, parseId } from "@/lib/http/operator_handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ resolution: z.enum(["filed", "dismissed"]) });

/** Settle an escalation step only a person can take: the ICANN complaint was filed, or the step is dismissed. */
export async function POST(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
	return operatorHandler(request, async () => {
		const eventId = parseId((await params).eventId);
		const body = bodySchema.safeParse(await request.json().catch(() => undefined));
		if (eventId === undefined || !body.success) return Response.json({ error: "Invalid request." }, { status: 400 });
		await resolveEscalationStep(eventId, body.data.resolution);
		return Response.json({ ok: true });
	});
}
