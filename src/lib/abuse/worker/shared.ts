import crypto from "node:crypto";

import { AbuseRepository } from "../repository";
import { reportAccessSteps } from "../access_steps";
import type { resolveAbuseTarget } from "../resolver";
import type { BrowserTask, ChatModel } from "../../browser/task/agent";
import type { FabricCdpSessionAcquirer } from "../../browser/task/fabric";
import { asRecord } from "../../util/values";

export type UnknownExternalStateParams = {
	routeId: bigint;
	runId?: bigint;
	error: string;
	reason: string;
};

export type WorkerServices = {
	readonly owner: string;
	/** Per-job cancellation signal. Provider adapters must honor it before and
	 * during any potentially long external operation. */
	readonly signal?: AbortSignal;
	/** The model that drives browser tasks; throws when it is not configured. */
	browserTaskModel(): ChatModel;
	/** Leases the disposable Fabric browser a browser task runs on. */
	acquireBrowserSession: FabricCdpSessionAcquirer;
	markUnknownExternal(params: UnknownExternalStateParams): Promise<void>;
};

export type AbuseTargetResolver = typeof resolveAbuseTarget;

/** Throw a regular Error rather than relying on AbortSignal.reason support in
 * every runtime/provider SDK. This is used at every irreversible boundary. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	const reason = signal.reason;
	if (reason instanceof Error) throw reason;
	throw new Error("Abuse job was canceled before the external operation completed.");
}

export function idFrom(value: bigint | null | undefined, name: string): bigint {
	if (value === null || value === undefined) throw new Error(`Abuse job is missing ${name}.`);
	return value;
}

export function parseJobBigInt(value: unknown, name: string): bigint {
	if (typeof value === "bigint") return value;
	if (typeof value !== "string" && typeof value !== "number") throw new Error(`Abuse job is missing ${name}.`);
	try {
		const parsed = BigInt(value);
		if (parsed < 0n) throw new Error();
		return parsed;
	} catch {
		throw new Error(`Abuse job has an invalid ${name}.`);
	}
}

export function randomOwner(): string {
	return `${process.pid}-${crypto.randomBytes(10).toString("hex")}`;
}

/**
 * An external call can have succeeded even when its HTTP response was lost.
 * Such a job must stop permanently until an operator or a reconciliation
 * action resolves it; retrying it blindly could duplicate a provider report.
 */
export class UnknownExternalStateError extends Error {
	readonly unknownExternalState = true;
}

/** An SMTP rejection before a durable provider acceptance is safe to retry. */
export class RetryableDeliveryError extends Error {}

/** Read only a task shape that this service itself persisted before running it. */
export function storedBrowserTask(value: unknown): BrowserTask | undefined {
	const task = asRecord(value);
	if (
		!task
		|| typeof task.goal !== "string"
		|| !task.goal.trim()
		|| typeof task.startUrl !== "string"
		|| !Number.isInteger(task.maxSteps)
		|| (task.maxSteps as number) < 1
		|| !asRecord(task.resultSchema)
	) {
		return undefined;
	}
	try {
		const url = new URL(task.startUrl);
		if (url.protocol !== "https:" || url.username || url.password) return undefined;
	} catch {
		return undefined;
	}
	return { goal: task.goal, startUrl: task.startUrl, maxSteps: task.maxSteps as number, resultSchema: asRecord(task.resultSchema)! };
}

export async function routeContext(routeId: bigint) {
	const route = await AbuseRepository.getRoute(routeId);
	if (!route) throw new Error("Abuse route no longer exists.");
	const input = await AbuseRepository.getReportInput(route.reportId);
	if (!input) throw new Error("Abuse report no longer exists.");
	const target = input.targets.find((item) => item.id === route.targetId);
	if (!target) throw new Error("Abuse route target no longer exists.");
	// The steps a reviewer repeats to get past the site's login or gate, from the case's walk.
	const accessSteps = await reportAccessSteps(input.report.submissionId, target.observedUrls);
	return { route, ...input, target, ...(accessSteps.length ? { accessSteps } : {}) };
}
