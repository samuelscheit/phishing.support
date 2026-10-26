import { AbuseRepository } from "@/lib/abuse/repository";
import { safePublicError } from "@/lib/abuse/security";
import { getProviderSubmissionProvider } from "@/lib/abuse/providers/submission_registry_default";
import { buildProviderReportNarrative } from "@/lib/abuse/providers/report_payload";
import type { AbuseMailClassification } from "@/lib/abuse/schema";

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

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
	createdAt: Date;
	updatedAt: Date;
};

export type SubmissionReportArtifact = { id: bigint; name: string; kind: string; mimeType: string; size: number };

export type SubmissionReport = {
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
	legalBrandUrl?: string | null;
}): { body: string; bodySource: "prepared" | "preview" | "historical" } {
	const payload = recordValue(params.providerPayload);
	// Only a provider-specific narrative (v1) or a migrated record's own text is
	// shown verbatim. Older payloads used an analysis excerpt as their text.
	if (payload?.adapter === "historical_report") {
		const body = nonEmptyString(payload.body);
		if (body) return { body, bodySource: "historical" };
	}
	if (payload?.providerNarrativeVersion === 1) {
		const report = recordValue(payload.report);
		const form = recordValue(payload.form);
		const prepared = [report?.reason, report?.explanation, form?.justification].map(nonEmptyString).find(Boolean);
		if (prepared) return { body: prepared, bodySource: "prepared" };
	}

	const provider = getProviderSubmissionProvider(params.providerRegistryKey);
	const preview = provider?.buildReportPreview?.({
		target: params.target,
		observedUrls: params.observedUrls,
		description: params.description,
		legalBrandUrl: params.legalBrandUrl,
	}) ?? buildProviderReportNarrative({
		provider: "generic",
		target: params.target,
		observedUrls: params.observedUrls,
		description: params.description,
		...(params.legalBrandUrl ? { legalBrandUrl: params.legalBrandUrl } : {}),
		maximumLength: 1_000,
	});
	return {
		body: preview ?? "A provider-specific report draft will be shown when this route is prepared.",
		bodySource: payload ? "historical" : "preview",
	};
}

/** The submission's report, its provider routes, and all correspondence. */
export async function getReportForSubmission(submissionId: bigint): Promise<SubmissionReport | null> {
	const report = await AbuseRepository.getReportForSubmission(submissionId);
	if (!report) return null;

	const [targets, routes, runs, messages, artifacts] = await Promise.all([
		AbuseRepository.listTargets(report.id),
		AbuseRepository.listRoutes(report.id),
		AbuseRepository.listProviderRunsForReport(report.id),
		AbuseRepository.listMailForReport(report.id),
		AbuseRepository.listArtifactMetadata(report.id),
	]);
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
			occurredAt: message.occurredAt,
		});
		messagesByRoute.set(message.routeId, list);
	}

	return {
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
					createdAt: run?.createdAt ?? route.createdAt,
					updatedAt: run?.updatedAt ?? route.updatedAt,
				};
			}),
		artifacts,
	};
}
