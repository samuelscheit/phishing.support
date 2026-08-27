import { AbuseRepository } from "@/lib/abuse/repository";

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

/**
 * Return the standalone abuse emails belonging to a legacy website
 * submission. `legacy-website:<submission id>` is the durable idempotency
 * identity written by the analysis handoff; it avoids copying or duplicating
 * externally-delivered mail into the old report tables.
 */
export async function listStandaloneAbuseMailForSubmission(submissionId: bigint): Promise<SubmissionAbuseMailReport[]> {
	const report = await AbuseRepository.getReportByIdempotencyKey(`legacy-website:${submissionId.toString()}`);
	if (!report) return [];

	const [targets, routes, messages] = await Promise.all([
		AbuseRepository.listTargets(report.id),
		AbuseRepository.listRoutes(report.id),
		AbuseRepository.listMailForReport(report.id),
	]);
	const targetsById = new Map(targets.map((target) => [target.id, target.normalizedTarget]));
	const routesById = new Map(routes.map((route) => [route.id, route]));

	return messages
		.filter((message) => message.direction === "outbound")
		.flatMap((message): SubmissionAbuseMailReport[] => {
			const route = routesById.get(message.routeId);
			if (!route) return [];
			return [{
				id: message.id,
				provider: route.providerDisplayName,
				routeType: route.routeType,
				target: targetsById.get(route.targetId) ?? "Unknown target",
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
}
