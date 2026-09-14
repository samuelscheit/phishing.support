import {
	acquireFabricSkyvernTaskBinding,
	cancelFabricBrowserSession,
	heartbeatFabricBrowserSession,
	releaseFabricBrowserSession,
	type FabricSkyvernTaskBinding,
} from "../../browser/fabric";

import type { AbuseSkyvernAdapter } from "./adapter";
import type { SkyvernTaskPayload } from "./contracts";

export type FabricSkyvernTaskResult =
	| { state: "created"; skyvernRunId: string; fabricSessionId: string }
	| { state: "not_eligible" }
	| { state: "record_conflict"; skyvernRunId: string; fabricSessionId: string };

export type FabricSkyvernTaskFactory = typeof createFabricSkyvernTask;

/** The companion request may have reached Skyvern but missed its durable response boundary. */
export class FabricSkyvernTaskAmbiguityError extends Error {
	constructor(cause: unknown) {
		super(`Fabric-bound Skyvern task creation became ambiguous (${cause instanceof Error ? cause.message : String(cause)})`);
		this.name = "FabricSkyvernTaskAmbiguityError";
	}
}

/**
 * Create one existing Skyvern task against a Fabric browser lease.
 *
 * The local Skyvern service continues to own its dynamic report task and
 * output protocol. This adapter removes its browser authority: it gets a
 * short-lived fixed-origin relay path whose upstream is mTLS-authenticated by
 * the Fabric relay sidecar. A lost task response cancels the browser lease so
 * an unrecorded task cannot continue acting on a report.
 */
export async function createFabricSkyvernTask(params: {
	adapter: Pick<AbuseSkyvernAdapter, "createTask">;
	payload: SkyvernTaskPayload;
	metadata: Record<string, string | number | boolean | null>;
	prepare(): Promise<boolean>;
	record(input: { skyvernRunId: string; fabricSessionId: string }): Promise<boolean>;
	acquire?: (metadata: Record<string, string | number | boolean | null>) => Promise<FabricSkyvernTaskBinding>;
}): Promise<FabricSkyvernTaskResult> {
	const binding = await (params.acquire ?? acquireFabricSkyvernTaskBinding)({ operation: "skyvern-portal", ...params.metadata });
	let crossedSkyvernBoundary = false;
	let recorded = false;
	try {
		if (!(await params.prepare())) return { state: "not_eligible" };
		crossedSkyvernBoundary = true;
		try {
			const created = await params.adapter.createTask(params.payload, { browserAddress: binding.browserAddress });
			if (!(await params.record({ skyvernRunId: created.runId, fabricSessionId: binding.sessionId }))) {
				return { state: "record_conflict", skyvernRunId: created.runId, fabricSessionId: binding.sessionId };
			}
			recorded = true;
			return { state: "created", skyvernRunId: created.runId, fabricSessionId: binding.sessionId };
		} catch (error) {
			throw new FabricSkyvernTaskAmbiguityError(error);
		}
	} finally {
		if (!recorded) {
			if (crossedSkyvernBoundary) await binding.cancel().catch(() => undefined);
			else await binding.release().catch(() => undefined);
		}
	}
}

export async function heartbeatFabricSkyvernTask(sessionId: string): Promise<void> {
	await heartbeatFabricBrowserSession(sessionId);
}

export async function releaseFabricSkyvernTask(sessionId: string): Promise<void> {
	await releaseFabricBrowserSession(sessionId);
}

export async function cancelFabricSkyvernTask(sessionId: string): Promise<void> {
	await cancelFabricBrowserSession(sessionId);
}
