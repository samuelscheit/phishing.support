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

/** Safe, provider-neutral input for a read-only draft preview. */
export type ProviderReportPreviewContext = {
	target: string;
	observedUrls: readonly string[];
	description: string;
	legalBrandUrl?: string | null;
};

/**
 * Ephemeral state prepared immediately before the durable provider-call
 * marker. It is intentionally not persisted: short-lived browser sessions,
 * CAPTCHA tokens, and similar secrets must never become part of a provider
 * run's immutable payload. The optional disposer is best-effort cleanup and
 * must never turn a provider-confirmed result into a failure.
 */
export type ProviderSubmissionPreflight = {
	readonly state: unknown;
	readonly dispose?: () => Promise<void>;
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
	 * marker immediately before calling the provider's irreversible submit
	 * handler.
	 */
	prepareSubmission?(context: ProviderSubmissionContext): Promise<ProviderSubmissionPreparation>;
	/**
	 * Return true only when a `running/starting` durable payload predates the
	 * provider's current, safe draft format. The executor may refresh only this
	 * pre-marker state; it never rewrites a current draft or a request that has
	 * reached `submission_started`.
	 */
	shouldRefreshStartingPayload?(context: ProviderSubmissionContext): boolean;
	/** Build the provider-owned preview shown before a durable run exists. */
	buildReportPreview?(context: ProviderReportPreviewContext): string | undefined;
	/**
	 * Prepare ephemeral state without crossing the provider's complaint
	 * boundary. This runs after the durable run exists but before its
	 * `submission_started` marker. Failures remain safely retryable.
	 */
	prepareExternalSubmission?(context: ProviderSubmissionContext): Promise<ProviderSubmissionPreflight>;
	submit(context: ProviderSubmissionContext): Promise<ProviderSubmissionSuccess>;
	/** Provider entry point that consumes the ephemeral preflight state, when needed. */
	submitPrepared?(context: ProviderSubmissionContext, preflight: ProviderSubmissionPreflight): Promise<ProviderSubmissionSuccess>;
};
