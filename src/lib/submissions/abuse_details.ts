import { AbuseRepository } from "@/lib/abuse/repository";
import { safePublicError } from "@/lib/abuse/security";

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Public read-model shape for outbound mail produced by the standalone abuse
 * worker. The standalone aggregate intentionally remains separate from the
 * legacy submission tables, so this adapter is the one place where a legacy
 * submission detail view joins the two domains.
 */
export type SubmissionAbuseMailReport = {
	id: bigint;
	provider: string;
	routeType: string;
	target: string;
	status: string;
	fromAddress: string | null;
	toAddresses: string[];
	subject: string | null;
	textBody: string | null;
	messageId: string | null;
	replyAddress: string | null;
	occurredAt: Date;
};

/** Public read-model shape for a direct provider submission. */
export type SubmissionAbuseProviderReport = {
	id: bigint;
	provider: string;
	routeType: string;
	target: string;
	status: string;
	executionStatus: string | null;
	body: string;
	observedUrls: string[];
	submittedTargets: string[];
	confirmationId: string | null;
	confirmationText: string | null;
	finalUrl: string | null;
	error: string | null;
	createdAt: Date;
	updatedAt: Date;
};

export type SubmissionStandaloneAbuseDetails = {
	mailReports: SubmissionAbuseMailReport[];
	providerReports: SubmissionAbuseProviderReport[];
};

/**
 * Read the text that was pinned for a provider request without exposing the
 * rest of its provider-specific payload. Every current direct provider keeps
 * its report text under one of these reviewed fields; the aggregate
 * description is the safe fallback for a route that has not prepared a run.
 */
function providerReportBody(providerPayload: unknown, fallback: string): string {
	const payload = recordValue(providerPayload);
	const report = recordValue(payload?.report);
	const form = recordValue(payload?.form);
	const candidate = [
		report?.reason,
		report?.explanation,
		report?.description,
		form?.justification,
		payload?.reason,
		payload?.description,
	].map(nonEmptyString).find(Boolean);
	return candidate ?? fallback;
}

/**
 * Return standalone worker outcomes belonging to a legacy website submission.
 * `legacy-website:<submission id>` is the durable handoff identity; this
 * read model intentionally joins aggregates without copying correspondence or
 * provider runs into the legacy submission tables.
 */
export async function getStandaloneAbuseDetailsForSubmission(
	submissionId: bigint,
): Promise<SubmissionStandaloneAbuseDetails> {
	const report = await AbuseRepository.getReportByIdempotencyKey(`legacy-website:${submissionId.toString()}`);
	if (!report) return { mailReports: [], providerReports: [] };

	const [targets, routes, runs, messages] = await Promise.all([
		AbuseRepository.listTargets(report.id),
		AbuseRepository.listRoutes(report.id),
		AbuseRepository.listProviderRunsForReport(report.id),
		AbuseRepository.listMailForReport(report.id),
	]);
	const targetsById = new Map(targets.map((target) => [target.id, target]));
	const routesById = new Map(routes.map((route) => [route.id, route]));
	const latestRunByRoute = new Map<bigint, (typeof runs)[number]>();
	for (const run of runs) if (!latestRunByRoute.has(run.routeId)) latestRunByRoute.set(run.routeId, run);

	const mailReports = messages
		.filter((message) => message.direction === "outbound")
		.flatMap((message): SubmissionAbuseMailReport[] => {
			const route = routesById.get(message.routeId);
			if (!route) return [];
			return [{
				id: message.id,
				provider: route.providerDisplayName,
				routeType: route.routeType,
				target: targetsById.get(route.targetId)?.normalizedTarget ?? "Unknown target",
				status: message.status,
				fromAddress: message.fromAddress,
				toAddresses: message.toAddresses,
				subject: message.subject,
				textBody: message.textBody,
				messageId: message.messageId,
				replyAddress: message.replyAddress,
				occurredAt: message.occurredAt,
			}];
		});
	const providerReports = routes
		.filter((route) => route.routeType === "provider_submission")
		.map((route) => {
			const target = targetsById.get(route.targetId);
			const run = latestRunByRoute.get(route.id);
			return {
				id: route.id,
				provider: route.providerDisplayName,
				routeType: route.routeType,
				target: target?.normalizedTarget ?? "Unknown target",
				status: route.status,
				executionStatus: run?.executionStatus ?? null,
				body: providerReportBody(run?.providerPayload, report.description),
				observedUrls: target?.observedUrls ?? [],
				submittedTargets: run?.submittedTargets ?? [],
				confirmationId: run?.confirmationId ?? null,
				confirmationText: run?.confirmationText ?? null,
				finalUrl: run?.finalUrl ?? null,
				error: safePublicError(route.status, run?.failureReason) ?? null,
				createdAt: run?.createdAt ?? route.createdAt,
				updatedAt: run?.updatedAt ?? route.updatedAt,
			};
		});

	return { mailReports, providerReports };
}
