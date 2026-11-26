import { NextRequest } from "next/server";
import { z } from "zod";

import { MAX_MESSAGE, visitControlOf, type ControlResult } from "@/lib/site_visit/control";
import { LIVE_INPUT } from "@/lib/site_visit/live_input";

export const dynamic = "force-dynamic";

/** A viewer's own random id, kept by its browser tab: it holds the controls while it drives. */
const viewer = z.string().regex(/^[A-Za-z0-9-]{16,64}$/);
const token = z.string().uuid();

const COMMAND = z.discriminatedUnion("action", [
	z.object({ action: z.literal("take"), viewer }),
	z.object({ action: z.literal("release"), viewer, token, note: z.string().max(MAX_MESSAGE).optional() }),
	z.object({ action: z.literal("input"), viewer, token, inputs: z.array(LIVE_INPUT).min(1).max(60) }),
	z.object({ action: z.literal("message"), viewer, text: z.string().min(1).max(MAX_MESSAGE) }),
]);

/**
 * Drive a case's live visit: take the browser over, send it input, hand it
 * back, or write to the agent. Anyone watching the live visit may; one
 * person drives at a time, and only with the token their take returned.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const parsed = COMMAND.safeParse(await req.json().catch(() => undefined));
	if (!parsed.success) return Response.json({ error: "Invalid command." }, { status: 400 });
	const control = visitControlOf(id);
	if (!control) return Response.json({ error: "The visit is not live." }, { status: 404 });
	const command = parsed.data;
	const result: ControlResult = command.action === "take" ? control.take(command.viewer)
		: command.action === "release" ? await control.release(command.viewer, command.token, command.note)
			: command.action === "input" ? await control.input(command.viewer, command.token, command.inputs)
				: control.message(command.viewer, command.text);
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	const { ok: _ok, ...body } = result;
	return Response.json(body);
}
