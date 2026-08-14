import type { AbuseProviderRoute } from "../schema";
import type { ResolvedRouteInput } from "../route_contracts";
import type { WorkerServices } from "../worker/shared";

/**
 * The small, provider-neutral descriptor that generic code is allowed to
 * inspect. Form details, mailbox policy, and evidence rules stay with the
 * concrete provider implementation.
 */
export type PortalProviderDefinition = {
	key: string;
	displayName: string;
	version: string;
	contentHash: string;
	routeType: "skyvern_portal";
	registrarIds: readonly number[];
	verifiedDomains: readonly string[];
	allowedReplyLinkDomains: readonly string[];
	escalation: { allowExplicitUnmonitoredReplyLink: boolean };
};

export type ProviderInboxCandidate = {
	senderAddresses: readonly string[];
	recipients: readonly string[];
	textBody: string;
};

export type StoredProviderInboxMessage = {
	routeId: bigint;
	reportId: bigint;
	messageId: bigint;
};

export type ProviderReconciliationServices = Pick<WorkerServices, "getAdapter" | "markUnknownExternal">;

export type ProviderRetryExhaustion = {
	routeId: bigint;
	runId?: bigint;
	jobType: string;
	error: string;
};

/**
 * A code-owned portal provider owns every vendor-specific lifecycle rule.
 * Generic infrastructure selects one implementation by registry key but does
 * not inspect provider names, form contracts, mailbox policy, or payloads.
 */
export type PortalProvider = {
	readonly definition: PortalProviderDefinition;
	createRegistrarRoute(params: { registrarId: number; resolutionSnapshot: Record<string, unknown> }): ResolvedRouteInput;
	verifyRoute(routeId: bigint): Promise<void>;
	runPortal(routeId: bigint, worker: WorkerServices): Promise<void>;
	reconcileRun(runId: bigint, worker: ProviderReconciliationServices): Promise<void>;
	/** Optional capabilities keep mailbox/code workflows out of providers that do not use them. */
	deliverVerificationCode?(params: { routeId: bigint; runId?: bigint; payload: Record<string, unknown> }, worker: WorkerServices): Promise<void>;
	findInboundRoute?(candidate: ProviderInboxCandidate): Promise<AbuseProviderRoute | undefined>;
	onInboundMessageStored?(message: StoredProviderInboxMessage): Promise<void>;
	maintain?(): Promise<void>;
	/** Let a provider fence an externally active task before generic failure handling downgrades its route. */
	onRetryExhausted?(params: ProviderRetryExhaustion, worker: Pick<WorkerServices, "markUnknownExternal">): Promise<boolean>;
};
