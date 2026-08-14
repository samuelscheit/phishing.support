import { eq } from "drizzle-orm";

import { getDb } from "../../db";
import { generateId } from "../../db/ids";
import { abuseWebhookEvents, type AbuseJob } from "../schema";
import { enqueueJob } from "./jobs";
import { getProviderRunBySkyvernRunId } from "./provider_runs";
import { now } from "./shared";

export async function persistWebhook(params: { eventId: string; skyvernRunId?: string; timestamp: number; payload: Record<string, unknown>; payloadHash: string }): Promise<boolean> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const existing = tx.select({ id: abuseWebhookEvents.id }).from(abuseWebhookEvents).where(eq(abuseWebhookEvents.eventId, params.eventId)).get();
			if (existing) return false;
			tx.insert(abuseWebhookEvents)
				.values({
					id: generateId(),
					eventId: params.eventId,
					skyvernRunId: params.skyvernRunId,
					timestamp: params.timestamp,
					payload: params.payload,
					payloadHash: params.payloadHash,
					receivedAt: now(),
				})
				.run();
			return true;
		},
		{ behavior: "immediate" }
	);
}

export async function enqueueReconciliationForSkyvernRun(skyvernRunId: string): Promise<AbuseJob | undefined> {
	const run = await getProviderRunBySkyvernRunId(skyvernRunId);
	if (!run) return undefined;
	return enqueueJob({
		jobType: "reconcile_skyvern_run",
		reportId: run.reportId,
		routeId: run.routeId,
		runId: run.id,
		payload: { skyvernRunId },
		dedupeKey: `reconcile:${run.id.toString()}:${skyvernRunId}`,
	});
}
