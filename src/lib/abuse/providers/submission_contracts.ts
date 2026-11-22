import type { AccountIdentifierExtractor } from "../followup/account_identifiers";
import type { AbuseMailClassification, AbuseTargetType } from "../schema";

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
	/**
	 * IANA registrar IDs whose domains this provider reports through its own
	 * form, whatever mailbox the RDAP record names (it may not exist).
	 */
	readonly registrarIds?: readonly number[];
	/** Whether this provider should run in addition to the mailbox-selected one. */
	readonly supplemental: boolean;
	/**
	 * Mail the provider's mailbox when its direct submission settles without
	 * filing anything (refused, needs a person, or nothing to draft), in the
	 * format its mailbox processes: `xarf` is an XARF v4 report
	 * (multipart/report with xarf.json) for mailboxes run by XARF tooling.
	 */
	readonly emailFallback?: { readonly format: "plain" | "xarf" };
	/**
	 * Code-owned target rules for an independent supplemental submission. This
	 * keeps provider-specific eligibility in provider definitions rather than
	 * branching on a provider name in resolver code.
	 */
	readonly supplementalTargets?: readonly {
		readonly targetType: AbuseTargetType;
		readonly requiresObservedUrl?: boolean;
		/** Regular-expression source an observed URL must match, e.g. one service's webhook URLs. */
		readonly observedUrlPattern?: string;
	}[];
};

/** The durable route/run context passed to one provider-owned submission. */
export type ProviderSubmissionContext = {
	routeId: bigint;
	runId?: bigint;
	payload: Record<string, unknown>;
	/** Ephemeral worker deadline; never persisted with the provider payload. */
	signal?: AbortSignal;
};

/** Safe, provider-neutral input for a read-only draft preview. */
export type ProviderReportPreviewContext = {
	target: string;
	observedUrls: readonly string[];
	description: string;
	allegationCategory?: string;
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
 * A provider cannot proceed automatically and needs a person (for example an
 * expired account session or a form that requires reauthentication). The
 * route settles terminally as `needs_human`; it is neither a provider
 * rejection nor an ambiguous external state. Throw it only when the failure
 * is explicit and known: before the durable marker nothing was submitted, and
 * after it the provider must have unambiguously refused the request.
 */
export class ProviderSubmissionNeedsHumanError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProviderSubmissionNeedsHumanError";
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

/** One message the provider sent about a filed report, read from its own API. */
export type ProviderCorrespondenceMessage = {
	/** Provider-assigned ID; it deduplicates repeated fetches. */
	id: string;
	subject: string;
	body: string;
	recipient?: string;
	sentAt: Date;
};

/** The provider's current record of a filed report. */
export type ProviderCorrespondence = {
	messages: ProviderCorrespondenceMessage[];
	/** Review state, for example `accepted` or `denied`, with the provider's reason. */
	status?: { state: string; detail?: string };
	/** The provider says the review is over (Netcraft's `pending: false`): no further reads are needed. */
	final?: boolean;
};

/** Mail a provider sends to the service mailbox about reports it received. */
export type ProviderInboundMail = {
	/** Registrable domains of the authenticated notification senders. */
	readonly senderDomains: readonly string[];
	/**
	 * What a matched message is: a machine "notification" (a receipt, the
	 * default) or a human "reply" that the regular reply classifier reads,
	 * because it can ask for more information.
	 */
	readonly messageKind?: "notification" | "reply";
	/**
	 * The provider receipt IDs a notification names. Absent when the
	 * provider's API is the authoritative correspondence source, so its
	 * mail is not attached to a case a second time.
	 */
	confirmationIds?(text: string): string[];
	/**
	 * The decision a notification states, when it states one ("no threats
	 * were found"). A notification without one is a receipt: acknowledged.
	 */
	verdictOf?(text: string): AbuseMailClassification | undefined;
};

/** A composed answer to a provider's review decision, with its evidence files. */
export type DecisionAnswer = {
	confirmationId: string;
	body: string;
	attachments: ReadonlyArray<{ filename: string; mimeType: string; content: Buffer }>;
	signal?: AbortSignal;
};

export type DecisionAnswerChannel =
	| { readonly kind: "email"; readonly replyAddress: string; subject(confirmationId: string): string }
	| {
		readonly kind: "form";
		/** How the case page names where the answer went, e.g. "Eranet's supplement form". */
		readonly name: string;
		/** What the form insists on, told to whoever writes the answer. */
		readonly requirements?: string;
		/**
		 * Submit the answer through the provider's form. `markSending` records
		 * the answer durably and must be awaited right before the one request
		 * that files it: a failure before it is retried, one after it never is.
		 * A named refusal of that request throws ProviderSubmissionRejectedError.
		 */
		submit(answer: DecisionAnswer, markSending: () => Promise<void>): Promise<void>;
	};

/** How a provider files its complaint: one request, or a preflight before the marker and the request after it. */
export type ProviderSubmissionFiling =
	| {
		/** The irreversible call. */
		submit(context: ProviderSubmissionContext): Promise<ProviderSubmissionSuccess>;
	}
	| {
		/**
		 * Prepare ephemeral state without crossing the provider's complaint
		 * boundary. This runs after the durable run exists but before its
		 * `submission_started` marker; `verified` is what `verifyDraft` returned
		 * for this attempt. Failures remain safely retryable.
		 */
		prepareExternalSubmission(context: ProviderSubmissionContext, verified: unknown): Promise<ProviderSubmissionPreflight>;
		/** The irreversible call, consuming the preflight. */
		submitPrepared(context: ProviderSubmissionContext, preflight: ProviderSubmissionPreflight): Promise<ProviderSubmissionSuccess>;
	};

/**
 * A direct provider integration. Generic code selects it from the registry
 * and invokes it, but never branches on provider names or request details.
 */
export type ProviderSubmissionProvider = ProviderSubmissionFiling & {
	readonly definition: ProviderSubmissionDefinition;
	/**
	 * Pre-marker validation and payload construction. It must not make an
	 * irreversible provider request; generic execution writes the durable
	 * marker immediately before calling the provider's irreversible call.
	 */
	prepareSubmission(context: ProviderSubmissionContext): Promise<ProviderSubmissionPreparation>;
	/**
	 * Prove the stored draft is still exactly what the provider builds from the
	 * current route and report; it throws when it is not. The executor runs it
	 * once per attempt before any preflight and before the marker, so a drift
	 * ends the attempt where nothing was filed, and hands the result to the
	 * preflight. After the marker a provider only reads its stored payload and
	 * sends its one request.
	 */
	verifyDraft(context: ProviderSubmissionContext): Promise<unknown>;
	/** Build the provider-owned preview shown before a durable run exists. */
	buildReportPreview?(context: ProviderReportPreviewContext): string | undefined;
	/**
	 * Read-only: find the report a submission filed when its answer was lost
	 * (a gateway timeout, a dropped connection), by the immutable payload it
	 * sent. Undefined when the provider lists no such report (yet). The worker
	 * looks again on a bounded schedule and settles the route on a match; it
	 * never submits a second time.
	 */
	findSubmission?(context: ProviderSubmissionContext & { sentAt: Date }): Promise<ProviderSubmissionSuccess | undefined>;
	readonly inboundMail?: ProviderInboundMail;
	/**
	 * How to answer a review decision the provider reports through its API.
	 * A contested state (for example Cloudflare's `denied`) gets one reply per
	 * route with a fresh live check and reproduction steps.
	 */
	readonly decisionFollowUp?: {
		readonly contestedStates: readonly string[];
		/** Whom the answer greets: "Hello <addressee> Trust & Safety". */
		readonly addressee: string;
		/** Where the answer goes: the mailbox the provider's decision names, or the provider's own form. */
		readonly channel: DecisionAnswerChannel;
		/** Finds identifiers in a kit's pages that belong to an account at this provider, e.g. Turnstile sitekeys. */
		readonly accountIdentifiers?: AccountIdentifierExtractor;
	};
	/**
	 * Read the provider's correspondence for a submitted report by its
	 * receipt. The worker polls it for a bounded period after submission.
	 */
	fetchCorrespondence?(context: { confirmationId: string; signal?: AbortSignal }): Promise<ProviderCorrespondence>;
	/**
	 * What each review state `fetchCorrespondence` reports means for the
	 * report, in the same terms as a classified mail reply. A state without an
	 * entry (`processing`, `submitted`) is no decision yet.
	 */
	readonly reviewVerdicts?: Readonly<Record<string, AbuseMailClassification>>;
};
