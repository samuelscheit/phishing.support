import { AbuseRepository } from "@/lib/abuse/repository";
import { safePublicError } from "@/lib/abuse/security/security";
import { getProviderSubmissionProvider } from "@/lib/abuse/providers/submission_registry_default";
import { buildProviderReportNarrative } from "@/lib/abuse/providers/kit/report_payload";
import type { AbuseJobType, AbuseMailClassification, AbuseProviderRoute, AbuseReport } from "@/lib/abuse/schema";
import { describeDecisionFollowUp, type DecisionFollowUpSummary } from "@/lib/abuse/followup/describe";
import { asRecord } from "../util/values";
import { parseFunnelPartyTarget, type FunnelPartyTarget } from "@/lib/abuse/funnel/target";
import { cleanMailText, type CleanMailText } from "@/lib/abuse/mail/clean_text";
import type { ProviderDecision } from "@/lib/abuse/providers/submission_contracts";
import { organisationOf, type Organisation } from "@/lib/provider_stats/organisation";
import { roleOf, type ProviderRole } from "@/lib/provider_stats/role";
import { routeEventFacts, routeOutcomeOf, type RouteOutcome } from "@/lib/provider_stats/route_outcome";

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

/** One sent report or received reply on a route. Raw MIME and attachments are report artifacts. */
export type SubmissionReportMessage = {
	id: bigint;
	direction: "outbound" | "inbound";
	kind: string;
	status: string;
	classification: AbuseMailClassification | null;
	fromAddress: string | null;
	toAddresses: string[];
	subject: string | null;
	/** The body as clean text, with our report as the provider quoted it back split off; null for a review-state record or an empty body. */
	text: CleanMailText | null;
	/** A review state the provider's API reported ("accepted", "denied" with its reason), recorded by our poll: no message of the provider's own. */
	providerState: { state: string; detail: string | null } | null;
	/** What the provider decided, as this message or state says it, read by the provider's own rules. */
	decision: ProviderDecision | null;
	messageId: string | null;
	replyAddress: string | null;
	rawArtifactId: bigint | null;
	attachmentArtifactIds: string[];
	/** An outbound answer to a provider's review decision, not the report itself. */
	decisionReply: boolean;
	occurredAt: Date;
};

/** Work queued on a route that the case page tells as what happens next. */
export type RouteNextWork = { kind: "receipt_lookup" | "status_check" | "decision_answer" | "submission"; at: Date };

const NEXT_WORK: Partial<Record<AbuseJobType, RouteNextWork["kind"]>> = {
	find_provider_receipt: "receipt_lookup",
	poll_provider_correspondence: "status_check",
	follow_up_provider_decision: "decision_answer",
	submit_provider: "submission",
	send_email: "submission",
	run_portal: "submission",
};

/** One provider route of the submission's report: an abuse mailbox, a direct provider, or a historical record. */
export type SubmissionReportRoute = {
	id: bigint;
	provider: string;
	/** The company the route reaches, named as people know it ("Cloudflare", "Sollutium-NL"). */
	organisation: string;
	/** The part the company plays for the target: registrar, host, CDN, blocklist. */
	role: ProviderRole;
	/** How the report was filed: "email", or the provider's own channel ("dashboard API", "web form"). */
	channel: string;
	/** How the provider answered, as the provider statistics count it. */
	outcome: RouteOutcome;
	/** The route another route's answer led to: the host Cloudflare named for a proxied site. */
	namedBy: { routeId: bigint; organisation: string } | null;
	/** Queued work on the route, soonest first. */
	nextWork: RouteNextWork[];
	routeType: string;
	target: string;
	/** The mailbox a mail route sends to, once resolved and verified. */
	recipient: string | null;
	status: string;
	executionStatus: string | null;
	/** Provider-specific text; absent for mail routes, whose text is in `messages`. */
	body: string | null;
	bodySource: "prepared" | "preview" | "historical" | null;
	observedUrls: string[];
	submittedTargets: string[];
	confirmationId: string | null;
	confirmationText: string | null;
	finalUrl: string | null;
	error: string | null;
	messages: SubmissionReportMessage[];
	/** How each review decision the provider sent was answered, or why it was not. */
	decisionFollowUps: DecisionFollowUpSummary[];
	createdAt: Date;
	updatedAt: Date;
};

export type SubmissionReportArtifact = { id: bigint; name: string; kind: string; mimeType: string; size: number };

/**
 * What a report is about for its case: the reported site or email itself, or
 * a host its evidence led to: the host serving the payload its command
 * downloads, a data drop its form sends to, a redirector in front of it, or
 * the business of a deceptive funnel.
 */
export type ReportSubject = "site" | "email" | "payload_host" | "data_drop" | "redirector" | "funnel" | "linked";

const SUBJECT_BY_KEY_PREFIX: Readonly<Record<string, ReportSubject>> = {
	"payload-host": "payload_host",
	"data-drop": "data_drop",
	exfil: "data_drop",
	redirector: "redirector",
	funnel: "funnel",
};

function reportSubjectOf(idempotencyKey: string | null, target: string | undefined): ReportSubject {
	if (!idempotencyKey) return target === "phishing-email" ? "email" : "site";
	return SUBJECT_BY_KEY_PREFIX[idempotencyKey.slice(0, idempotencyKey.indexOf(":"))] ?? "linked";
}

/** "Sollutium-NL - SOLLUTIUM EU Sp z.o.o., PL" → "Sollutium-NL"; "NameSilo Phishing Report" → "NameSilo". */
function shortProviderName(displayName: string): string {
	return displayName.split(" - ")[0]!.replace(/\s+(?:abuse(?: team| desk| contact)?|(?:fraud & )?phishing report|abuse report)$/i, "").trim() || displayName;
}

/** A known company by its own name; another by the name its route carries, not its mailbox domain. */
function organisationName(route: Pick<AbuseProviderRoute, "providerDisplayName">, organisation: Organisation): string {
	return organisation.role ? organisation.name : shortProviderName(route.providerDisplayName);
}

export type SubmissionReport = {
	id: bigint;
	/** The website or email case the report was made from; null for reports made through the API. */
	submissionId: bigint | null;
	/** The case's own report of a site (or of its email), rather than one derived from its evidence (a data drop, a payload host, a redirector). */
	primary: boolean;
	/** What the report is about for its case. */
	subject: ReportSubject;
	/** What the report is about: its first target. */
	target: string | null;
	/** Other cases that confirmed the same site, or led to the same affiliate, while this report was open, and joined it instead of a report of their own. */
	joinedCases: bigint[];
	/** For a deceptive funnel's report: the business it goes to and the affiliate it is about. */
	funnelParty?: FunnelPartyTarget;
	description: string;
	allegationCategory?: string;
	status: string;
	createdAt: Date;
	updatedAt: Date;
	routes: SubmissionReportRoute[];
	artifacts: SubmissionReportArtifact[];
};

/**
 * Read a pinned provider-specific draft without exposing its complete payload.
 * Historical runs that predate provider-specific drafts show a reference
 * preview instead of the analysis excerpt they were filed with.
 */
function providerReportBody(params: {
	providerRegistryKey: string;
	providerPayload: unknown;
	target: string;
	observedUrls: string[];
	description: string;
	allegationCategory?: string;
	legalBrandUrl?: string | null;
}): { body: string; bodySource: "prepared" | "preview" | "historical" } {
	const payload = asRecord(params.providerPayload);
	// A prepared provider text or a migrated record's own text is shown verbatim.
	if (payload?.adapter === "historical_report") {
		const body = nonEmptyString(payload.body);
		if (body) return { body, bodySource: "historical" };
	}
	const prepared = [asRecord(payload?.report)?.reason, asRecord(payload?.report)?.explanation, asRecord(payload?.form)?.justification].map(nonEmptyString).find(Boolean);
	if (prepared) return { body: prepared, bodySource: "prepared" };

	const provider = getProviderSubmissionProvider(params.providerRegistryKey);
	const preview = provider?.buildReportPreview?.({
		target: params.target,
		observedUrls: params.observedUrls,
		description: params.description,
		...(params.allegationCategory ? { allegationCategory: params.allegationCategory } : {}),
		legalBrandUrl: params.legalBrandUrl,
	}) ?? buildProviderReportNarrative({
		provider: "generic",
		target: params.target,
		observedUrls: params.observedUrls,
		description: params.description,
		...(params.allegationCategory ? { allegationCategory: params.allegationCategory } : {}),
		...(params.legalBrandUrl ? { legalBrandUrl: params.legalBrandUrl } : {}),
		maximumLength: 1_000,
	});
	return {
		body: preview ?? "A provider-specific report draft will be shown when this route is prepared.",
		bodySource: payload ? "historical" : "preview",
	};
}

async function hydrateSubmissionReport(report: AbuseReport): Promise<SubmissionReport> {
	const [targets, routes, runs, messages, artifacts, events, joinedCases, queuedJobs] = await Promise.all([
		AbuseRepository.listTargets(report.id),
		AbuseRepository.listRoutes(report.id),
		AbuseRepository.listProviderRunsForReport(report.id),
		AbuseRepository.listMailForReport(report.id),
		AbuseRepository.listArtifactMetadata(report.id),
		AbuseRepository.listEvents(report.id),
		AbuseRepository.listJoinedCases(report.id),
		AbuseRepository.listQueuedJobsForReport(report.id),
	]);
	const followUpsByRoute = new Map<bigint, DecisionFollowUpSummary[]>();
	for (const event of events) {
		const summary = event.routeId ? describeDecisionFollowUp(event) : undefined;
		if (!summary) continue;
		followUpsByRoute.set(event.routeId!, [...(followUpsByRoute.get(event.routeId!) ?? []), summary]);
	}
	const eventsByRoute = Map.groupBy(events, (event) => event.routeId);
	const targetsById = new Map(targets.map((target) => [target.id, target]));
	const latestRunByRoute = new Map<bigint, (typeof runs)[number]>();
	for (const run of runs) if (!latestRunByRoute.has(run.routeId)) latestRunByRoute.set(run.routeId, run);
	const messagesByRoute = Map.groupBy(messages, (message) => message.routeId);
	const routeOfMessage = new Map(messages.map((message) => [String(message.id), message.routeId]));
	const organisations = new Map(routes.map((route) => {
		const organisation = organisationOf(route);
		return [route.id, { organisation, name: organisationName(route, organisation) }];
	}));

	/** A stored message as the case page shows it: its text cleaned, a review state told apart, and the decision it states. */
	const messageView = (route: AbuseProviderRoute, message: (typeof messages)[number]): SubmissionReportMessage => {
		const provider = getProviderSubmissionProvider(route.providerRegistryKey);
		const providerState = message.correlationKey?.startsWith(`provider-api:${route.providerRegistryKey}:status:`)
			? { state: (message.subject ?? "").replace(/^Report status:\s*/, ""), detail: message.textBody || null }
			: null;
		const text = !providerState && message.textBody?.trim() ? cleanMailText(message.textBody) : null;
		const decision = message.direction !== "inbound" || !provider?.decisionOf ? undefined
			: providerState ? provider.decisionOf({ state: providerState.state, ...(providerState.detail ? { detail: providerState.detail } : {}) })
			: text ? provider.decisionOf({ text: text.main }) : undefined;
		return {
			id: message.id,
			direction: message.direction,
			kind: message.kind,
			status: message.status,
			classification: message.classification,
			fromAddress: message.fromAddress,
			toAddresses: message.toAddresses,
			subject: message.subject,
			text,
			providerState,
			decision: decision ?? null,
			messageId: message.messageId,
			replyAddress: message.replyAddress,
			rawArtifactId: message.rawArtifactId,
			attachmentArtifactIds: message.attachmentArtifactIds,
			decisionReply: message.direction === "outbound" && Boolean(message.correlationKey?.startsWith("decision-follow-up:")),
			occurredAt: message.occurredAt,
		};
	};

	const funnelParty = report.idempotencyKey?.startsWith("funnel:") && targets[0] ? parseFunnelPartyTarget(targets[0].normalizedTarget) : undefined;
	return {
		id: report.id,
		submissionId: report.submissionId,
		primary: !report.idempotencyKey,
		subject: reportSubjectOf(report.idempotencyKey, targets[0]?.normalizedTarget),
		target: targets[0]?.normalizedTarget ?? null,
		joinedCases,
		...(funnelParty ? { funnelParty } : {}),
		description: report.description,
		allegationCategory: report.allegationCategory,
		status: report.status,
		createdAt: report.createdAt,
		updatedAt: report.updatedAt,
		routes: routes
			.filter((route) => route.routeType !== "manual_unroutable" || routes.length === 1)
			.map((route) => {
				const target = targetsById.get(route.targetId);
				const run = latestRunByRoute.get(route.id);
				const stored = messagesByRoute.get(route.id) ?? [];
				const routeMessages = stored.map((message) => messageView(route, message));
				const { organisation, name } = organisations.get(route.id)!;
				const sourceMessage = asRecord(route.resolverProvenance)?.sourceMessageId;
				const namedByRoute = typeof sourceMessage === "string" ? routeOfMessage.get(sourceMessage) : undefined;
				const outcome = routeOutcomeOf({
					routeType: route.routeType,
					status: route.status,
					createdAt: route.createdAt,
					...routeEventFacts(eventsByRoute.get(route.id) ?? []),
					messages: stored,
				});
				const draft = route.routeType === "provider_submission"
					? providerReportBody({
						providerRegistryKey: route.providerRegistryKey,
						providerPayload: run?.providerPayload,
						target: target?.normalizedTarget ?? "Unknown target",
						observedUrls: target?.observedUrls ?? [],
						description: report.description,
						allegationCategory: report.allegationCategory,
						legalBrandUrl: report.legalBrandUrl,
					})
					: undefined;
				return {
					id: route.id,
					provider: route.providerDisplayName,
					organisation: name,
					role: roleOf(route, target?.targetType ?? "domain", organisation),
					channel: route.routeType === "email" ? "email" : getProviderSubmissionProvider(route.providerRegistryKey)?.channel ?? "online form",
					outcome,
					namedBy: namedByRoute !== undefined && namedByRoute !== route.id ? { routeId: namedByRoute, organisation: organisations.get(namedByRoute)?.name ?? "another provider" } : null,
					nextWork: queuedJobs.flatMap((job) => {
						const kind = NEXT_WORK[job.jobType];
						return job.routeId === route.id && kind ? [{ kind, at: job.nextAttemptAt }] : [];
					}),
					routeType: route.routeType,
					recipient: route.verifiedEmail ?? null,
					target: target?.normalizedTarget ?? "Unknown target",
					status: route.status,
					executionStatus: run?.executionStatus ?? null,
					body: draft?.body ?? null,
					bodySource: draft?.bodySource ?? null,
					observedUrls: target?.observedUrls ?? [],
					submittedTargets: run?.submittedTargets ?? [],
					confirmationId: run?.confirmationId ?? null,
					confirmationText: run?.confirmationText ?? null,
					finalUrl: run?.finalUrl ?? null,
					error: safePublicError(route.status, run?.failureReason ?? target?.disposition) ?? null,
					messages: routeMessages,
					decisionFollowUps: followUpsByRoute.get(route.id) ?? [],
					createdAt: run?.createdAt ?? route.createdAt,
					updatedAt: run?.updatedAt ?? route.updatedAt,
				};
			}),
		artifacts,
	};
}

/** The given reports with their provider routes and correspondence, in the order asked for; unknown ids are left out. */
export async function getReportsByIds(reportIds: readonly bigint[]): Promise<SubmissionReport[]> {
	const reports = await Promise.all(reportIds.map((id) => AbuseRepository.getReport(id)));
	return Promise.all(reports.filter((report) => report !== undefined).map(hydrateSubmissionReport));
}

/**
 * Every report of a submission, with its provider routes and correspondence:
 * its own reports (each confirmed site's first, then those derived from
 * them), then the open reports of other cases it joined for a site they
 * already report (`submissionId` names the owning case).
 */
export async function getReportsForSubmission(submissionId: bigint): Promise<SubmissionReport[]> {
	const [owned, joined] = await Promise.all([
		AbuseRepository.listReportsForSubmission(submissionId),
		AbuseRepository.listJoinedReportsForSubmission(submissionId),
	]);
	const ordered = [...owned.filter((report) => !report.idempotencyKey), ...owned.filter((report) => report.idempotencyKey), ...joined];
	return Promise.all(ordered.map(hydrateSubmissionReport));
}
