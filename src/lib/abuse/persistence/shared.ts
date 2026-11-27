import { and, eq } from "drizzle-orm";

import type { DbExecutor } from "../../db";
import { generateId } from "../../db/ids";
import { abuseArtifacts, abuseEvents, abuseProviderRoutes, abuseProviderRuns, type AbuseProviderRoute, type AbuseProviderRun, type AbuseRunStatus } from "../schema";
import { writeBlob } from "../../db/blobs";
import { hashStableJson } from "../../util/hash";

export function now(): Date {
	return new Date();
}

export type ArtifactValuesParams = {
	reportId: bigint;
	name: string;
	kind: string;
	mimeType: string;
	buffer: Buffer;
	targetId?: bigint;
	routeId?: bigint;
	runId?: bigint;
	metadata?: Record<string, unknown>;
};

/** Store the bytes first (`writeBlob`), then the row naming them. */
export function insertArtifact(tx: DbExecutor, params: ArtifactValuesParams): bigint {
	const { sha256, size } = writeBlob(params.buffer);
	const values = {
		id: generateId(),
		reportId: params.reportId,
		targetId: params.targetId,
		routeId: params.routeId,
		runId: params.runId,
		name: params.name,
		kind: params.kind,
		mimeType: params.mimeType,
		sha256,
		size,
		metadata: params.metadata,
		createdAt: now(),
	};
	tx.insert(abuseArtifacts).values(values).run();
	return values.id;
}

export function recordEvent(tx: DbExecutor, params: {
	reportId: bigint;
	eventType: string;
	data?: Record<string, unknown>;
	targetId?: bigint;
	routeId?: bigint;
	runId?: bigint;
	jobId?: bigint;
}) {
	tx.insert(abuseEvents)
		.values({
			id: generateId(),
			reportId: params.reportId,
			targetId: params.targetId,
			routeId: params.routeId,
			runId: params.runId,
			jobId: params.jobId,
			eventType: params.eventType,
			data: params.data ?? {},
			createdAt: now(),
		})
		.run();
}

/** Insert a provider run for a route and record `provider_run.created`; the one place that defines what a created run carries. */
export function insertProviderRun(
	tx: DbExecutor,
	route: Pick<AbuseProviderRoute, "id" | "reportId" | "targetId">,
	params: { providerPayload: Record<string, unknown>; correlationKey: string; executionStatus: AbuseRunStatus; timestamp?: Date },
): AbuseProviderRun {
	const id = generateId();
	const timestamp = params.timestamp ?? now();
	const payloadHash = hashStableJson(params.providerPayload);
	tx.insert(abuseProviderRuns)
		.values({
			id,
			reportId: route.reportId,
			routeId: route.id,
			providerPayload: params.providerPayload,
			payloadHash,
			correlationKey: params.correlationKey,
			attemptCount: 0,
			executionStatus: params.executionStatus,
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.run();
	recordEvent(tx, {
		reportId: route.reportId,
		targetId: route.targetId,
		routeId: route.id,
		runId: id,
		eventType: "provider_run.created",
		data: { payloadHash, correlationKey: params.correlationKey },
	});
	return tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, id)).get()!;
}

/** Move a route from `expected` to running; false when another worker moved it first. Records `route.status_changed`. */
export function claimRoute(
	tx: DbExecutor,
	route: Pick<AbuseProviderRoute, "id" | "reportId" | "targetId">,
	params: { expected: AbuseProviderRoute["status"]; reason: string; timestamp: Date },
): boolean {
	const claimed = tx
		.update(abuseProviderRoutes)
		.set({ status: "running", updatedAt: params.timestamp })
		.where(and(eq(abuseProviderRoutes.id, route.id), eq(abuseProviderRoutes.status, params.expected)))
		.returning({ id: abuseProviderRoutes.id })
		.get();
	if (!claimed) return false;
	recordEvent(tx, {
		reportId: route.reportId,
		targetId: route.targetId,
		routeId: route.id,
		eventType: "route.status_changed",
		data: { from: params.expected, to: "running", reason: params.reason },
	});
	return true;
}
