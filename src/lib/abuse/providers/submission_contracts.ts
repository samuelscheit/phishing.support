/**
 * Immutable provider metadata that generic direct-submission infrastructure
 * may inspect. Submission mechanics, credentials, and request payload rules
 * remain owned by each concrete provider implementation.
 */
export type ProviderSubmissionDefinition = {
	readonly key: string;
	readonly displayName: string;
	/** Immutable provider-definition pin stored with each durable route. */
	readonly version: string;
	/** Hash of the reviewed provider definition for later pin verification. */
	readonly contentHash: string;
	/** Explicit abuse mailboxes that select this provider, never a domain rule. */
	readonly exactMailboxes: readonly string[];
	/** Whether this provider should run in addition to the mailbox-selected one. */
	readonly supplemental: boolean;
	/**
	 * Code-owned target rules for an independent supplemental submission. This
	 * keeps provider-specific eligibility in provider definitions rather than
	 * branching on a provider name in resolver code.
	 */
	readonly supplementalTargets?: readonly {
		readonly targetType: "domain" | "ip";
		readonly requiresObservedUrl?: boolean;
	}[];
};

/** The durable route/run context passed to one provider-owned submission. */
export type ProviderSubmissionContext = {
	routeId: bigint;
	runId?: bigint;
	payload: Record<string, unknown>;
};

/** A provider can decline a report before submission without leaving external state ambiguous. */
export class ProviderSubmissionRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProviderSubmissionRejectedError";
	}
}

/**
 * Provider-owned work that is safe to perform before the durable submission
 * marker. The ready payload becomes the only input to the irreversible
 * `submit` call.
 */
export type ProviderSubmissionPreparation =
	| { outcome: "ready"; payload: Record<string, unknown> }
	| { outcome: "insufficient_evidence"; reason: string };

/**
 * A provider-confirmed acceptance. The provider owns interpreting its
 * response, while generic persistence retains the normalized confirmation
 * evidence together with the run/route settlement.
 */
export type ProviderSubmissionSuccess = {
	confirmationId?: string;
	confirmationText?: string;
	finalUrl?: string;
	/** Every success must name the target(s) the provider confirmed receiving. */
	submittedTargets: string[];
};

/**
 * A direct provider integration. Generic code selects it from the registry
 * and invokes it, but never branches on provider names or request details.
 */
export type ProviderSubmissionProvider = {
	readonly definition: ProviderSubmissionDefinition;
	/**
	 * Optional pre-marker validation and payload construction. It must not make
	 * an irreversible provider request; generic execution writes the durable
	 * marker immediately before calling `submit`.
	 */
	prepareSubmission?(context: ProviderSubmissionContext): Promise<ProviderSubmissionPreparation>;
	submit(context: ProviderSubmissionContext): Promise<ProviderSubmissionSuccess>;
};
