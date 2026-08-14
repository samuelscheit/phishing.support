import crypto from "node:crypto";

import { AbuseRepository } from "../repository";
import type { resolveAbuseTarget } from "../resolver";
import type { AbuseSkyvernAdapter, SkyvernTaskPayload } from "../skyvern";

export type UnknownExternalStateParams = {
	routeId: bigint;
	runId?: bigint;
	error: string;
	reason: string;
};

export type WorkerServices = {
	readonly owner: string;
	getAdapter(): AbuseSkyvernAdapter;
	markUnknownExternal(params: UnknownExternalStateParams): Promise<void>;
};

export type AbuseTargetResolver = typeof resolveAbuseTarget;

export function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

export function envInt(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
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

export function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Read only a payload shape that this service itself persisted before an SDK call. */
export function storedSkyvernTaskPayload(value: unknown): SkyvernTaskPayload | undefined {
	const task = recordValue(value);
	if (!task || typeof task.prompt !== "string" || typeof task.url !== "string" || !Number.isFinite(task.max_steps) || !recordValue(task.data_extraction_schema)) {
		return undefined;
	}
	try {
		const url = new URL(task.url);
		if (url.protocol !== "https:" || url.username || url.password) return undefined;
	} catch {
		return undefined;
	}
	return task as unknown as SkyvernTaskPayload;
}

export async function routeContext(routeId: bigint) {
	const route = await AbuseRepository.getRoute(routeId);
	if (!route) throw new Error("Abuse route no longer exists.");
	const input = await AbuseRepository.getReportInput(route.reportId);
	if (!input) throw new Error("Abuse report no longer exists.");
	const target = input.targets.find((item) => item.id === route.targetId);
	if (!target) throw new Error("Abuse route target no longer exists.");
	return { route, ...input, target };
}
