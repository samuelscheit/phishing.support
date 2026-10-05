import { generateId } from "../../db/ids";
import { abuseArtifacts, abuseEvents } from "../schema";
import { sha256Hex } from "../security";

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

export function artifactValues(params: ArtifactValuesParams) {
	return {
		id: generateId(),
		reportId: params.reportId,
		targetId: params.targetId,
		routeId: params.routeId,
		runId: params.runId,
		name: params.name,
		kind: params.kind,
		mimeType: params.mimeType,
		sha256: sha256Hex(params.buffer),
		size: params.buffer.byteLength,
		metadata: params.metadata,
		blob: params.buffer,
		createdAt: now(),
	};
}

export function insertArtifact(tx: any, params: ArtifactValuesParams): bigint {
	const values = artifactValues(params);
	tx.insert(abuseArtifacts).values(values).run();
	return values.id;
}

export function recordEvent(tx: any, params: {
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
