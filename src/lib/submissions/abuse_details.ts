import { AbuseRepository } from "@/lib/abuse/repository";
import { safePublicError } from "@/lib/abuse/security/security";
import { getProviderSubmissionProvider } from "@/lib/abuse/providers/submission_registry_default";
import { buildProviderReportNarrative } from "@/lib/abuse/providers/kit/report_payload";
import type { AbuseMailClassification, AbuseReport } from "@/lib/abuse/schema";
import { describeDecisionFollowUp, type DecisionFollowUpSummary } from "@/lib/abuse/followup/describe";
import { asRecord } from "../util/values";

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
	textBody: string | null;
	messageId: string | null;
	replyAddress: string | null;
	rawArtifactId: bigint | null;
	attachmentArtifactIds: string[];
	/** An outbound answer to a provider's review decision, not the report itself. */
	decisionReply: boolean;
	occurredAt: Date;
};

/** One provider route of the submission's report: an abuse mailbox, a direct provider, or a historical record. */
export type SubmissionReportRoute = {
	id: bigint;
	provider: string;
	routeType: string;
	target: string;
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

export type SubmissionReport = {
	id: bigint;
	/** The website or email case the report was made from; null for reports made through the API. */
	submissionId: bigint | null;
	/** The case's own report of a site (or of its email), rather than one derived from its evidence (a data drop, a payload host, a redirector). */
	primary: boolean;
	/** What the report is about: its first target. */
	target: string | null;
	/** Other cases that confirmed the same site while this report was open, and joined it instead of a report of their own. */
	joinedCases: bigint[];
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
	const [targets, routes, runs, messages, artifacts, events, joinedCases] = await Promise.all([
		AbuseRepository.listTargets(report.id),
		AbuseRepository.listRoutes(report.id),
		AbuseRepository.listProviderRunsForReport(report.id),
		AbuseRepository.listMailForReport(report.id),
		AbuseRepository.listArtifactMetadata(report.id),
		AbuseRepository.listEvents(report.id),
		AbuseRepository.listJoinedCases(report.id),
	]);
	const followUpsByRoute = new Map<bigint, DecisionFollowUpSummary[]>();
	for (const event of events) {
		const summary = event.routeId ? describeDecisionFollowUp(event) : undefined;
		if (!summary) continue;
		followUpsByRoute.set(event.routeId!, [...(followUpsByRoute.get(event.routeId!) ?? []), summary]);
	}
	const targetsById = new Map(targets.map((target) => [target.id, target]));
	const latestRunByRoute = new Map<bigint, (typeof runs)[number]>();
	for (const run of runs) if (!latestRunByRoute.has(run.routeId)) latestRunByRoute.set(run.routeId, run);
	const messagesByRoute = new Map<bigint, SubmissionReportMessage[]>();
	for (const message of messages) {
		const list = messagesByRoute.get(message.routeId) ?? [];
		list.push({
			id: message.id,
			direction: message.direction,
			kind: message.kind,
			status: message.status,
			classification: message.classification,
			fromAddress: message.fromAddress,
			toAddresses: message.toAddresses,
			subject: message.subject,
			textBody: message.textBody,
			messageId: message.messageId,
			replyAddress: message.replyAddress,
			rawArtifactId: message.rawArtifactId,
			attachmentArtifactIds: message.attachmentArtifactIds,
			decisionReply: message.direction === "outbound" && Boolean(message.correlationKey?.startsWith("decision-follow-up:")),
			occurredAt: message.occurredAt,
		});
		messagesByRoute.set(message.routeId, list);
	}

	return {
		id: report.id,
		submissionId: report.submissionId,
		primary: !report.idempotencyKey,
		target: targets[0]?.normalizedTarget ?? null,
		joinedCases,
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
				const routeMessages = messagesByRoute.get(route.id) ?? [];
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
					routeType: route.routeType,
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
