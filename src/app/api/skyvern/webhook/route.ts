import { NextRequest, NextResponse } from "next/server";

import { AbuseRepository } from "@/lib/abuse/repository";
import { AbuseInputError } from "@/lib/abuse/security";
import { skyvernRunIdFromWebhook, verifySkyvernWebhookSignature, webhookEventId } from "@/lib/abuse/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
	try {
		const raw = new Uint8Array(await request.arrayBuffer());
		const verified = verifySkyvernWebhookSignature({
			body: raw,
			signature: request.headers.get("x-skyvern-signature"),
			timestamp: request.headers.get("x-skyvern-timestamp"),
		});
		let payload: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(Buffer.from(raw).toString("utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
			payload = parsed as Record<string, unknown>;
		} catch {
			return NextResponse.json({ error: "Webhook body must be a JSON object." }, { status: 400 });
		}
		const runId = skyvernRunIdFromWebhook(payload);
		const eventId = webhookEventId(payload, verified.payloadHash, verified.timestamp, request.headers.get("x-skyvern-event-id"));
		const created = await AbuseRepository.persistWebhook({
			eventId,
			skyvernRunId: runId,
			timestamp: verified.timestamp,
			payload,
			payloadHash: verified.payloadHash,
		});
		if (created && runId) await AbuseRepository.enqueueReconciliationForSkyvernRun(runId);
		return NextResponse.json({ accepted: true, duplicate: !created }, { status: 202 });
	} catch (error) {
		if (error instanceof AbuseInputError) return NextResponse.json({ error: error.message }, { status: 400 });
		console.error("Skyvern webhook processing failed:", error);
		return NextResponse.json({ error: "Webhook could not be accepted." }, { status: 500 });
	}
}
