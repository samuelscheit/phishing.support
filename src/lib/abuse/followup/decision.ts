import { abuseEmailCaseUrl, sendAbuseEmailRoute } from "../mail";
import { getProviderSubmissionProvider } from "../providers";
import { AbuseRepository } from "../repository";
import { recordValue, UnknownExternalStateError } from "../worker/shared";
import { collectDecisionEvidence, type EvidenceFetcher } from "./evidence";
import { composeDecisionReply, type NarrativeWriter } from "./reply";

const MAX_ATTACHMENTS = 5;

export type DecisionFollowUpDependencies = {
	fetcher?: EvidenceFetcher;
	writeNarrative?: NarrativeWriter;
	send?: typeof sendAbuseEmailRoute;
	now?: () => Date;
};

/** The provider's own message about its decision: the newest provider-API mail that is not a status record. */
function providerDecisionMessage(messages: Awaited<ReturnType<typeof AbuseRepository.listMailForReport>>, routeId: bigint): string | undefined {
	return messages
		.filter((message) => message.routeId === routeId && message.direction === "inbound" && !message.correlationKey?.includes(":status:") && !/confirmation/i.test(message.subject ?? ""))
		.at(-1)?.textBody ?? undefined;
}

/**
 * Answer a provider that reviewed a filed report and found nothing (or found
 * it gone), once per route and decision. The reply restates a fresh live
 * check and exact reproduction steps, so a reviewer who looked in a browser
 * can see what the report describes. A decision the live check no longer
 * supports (the content is really gone) is not contested.
 */
export async function followUpProviderDecision(
	params: { routeId: bigint; state: string; detail?: string },
	dependencies: DecisionFollowUpDependencies = {},
): Promise<"sent" | "skipped"> {
	const route = await AbuseRepository.getRoute(params.routeId);
	const provider = route && getProviderSubmissionProvider(route.providerRegistryKey);
	const followUp = provider?.decisionFollowUp;
	if (!route || !followUp || !followUp.contestedStates.includes(params.state)) return "skipped";
	const run = await AbuseRepository.getLatestProviderRunForRoute(route.id);
	if (!run?.confirmationId) return "skipped";
	const input = await AbuseRepository.getReportInput(route.reportId);
	const target = input?.targets.find((item) => item.id === route.targetId);
	const reportedUrl = target?.observedUrls[0];
	if (!input || !target || !reportedUrl) return "skipped";

	const correlationKey = `decision-follow-up:${route.id.toString()}:${params.state}`;
	const mail = await AbuseRepository.listMailForReport(route.reportId);
	if (mail.some((message) => message.direction === "outbound" && message.correlationKey === correlationKey)) return "skipped";

	const evidence = await collectDecisionEvidence({
		observedUrl: reportedUrl,
		reportedUserAgent: input.report.reportedUserAgent,
		...(abuseEmailCaseUrl(input.report.submissionId) ? { caseUrl: abuseEmailCaseUrl(input.report.submissionId)! } : {}),
		...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
		...(dependencies.now ? { now: dependencies.now } : {}),
	});
	// The provider may be right: contest only what our server still receives.
	const stillServed = evidence.liveChecks.some((check) => check.status === 200 && (check.as === "the command's own downloader" || evidence.command));
	if (!stillServed) {
		await AbuseRepository.appendEvent({ reportId: route.reportId, routeId: route.id, eventType: "provider_decision.not_contested", data: { state: params.state, detail: params.detail ?? null, liveChecks: evidence.liveChecks } });
		return "skipped";
	}

	const reply = await composeDecisionReply({
		providerName: provider.definition.displayName.replace(/\s+Abuse$/i, ""),
		confirmationId: run.confirmationId,
		decision: { state: params.state, ...(params.detail ? { detail: params.detail } : {}), ...(providerDecisionMessage(mail, route.id) ? { providerMessage: providerDecisionMessage(mail, route.id)! } : {}) },
		allegationCategory: input.report.allegationCategory,
		target: target.normalizedTarget,
		reportedUrl,
		description: input.report.description,
		evidence,
	}, dependencies.writeNarrative);

	const attachments = input.evidenceArtifacts.slice(0, MAX_ATTACHMENTS).map((artifact) => ({ filename: artifact.name, mimeType: artifact.mimeType, content: Buffer.from(artifact.blob) }));
	const result = await (dependencies.send ?? sendAbuseEmailRoute)({
		routeId: route.id,
		runId: run.id,
		reportId: route.reportId,
		recipient: followUp.replyAddress,
		subject: followUp.subject(run.confirmationId),
		body: reply.body,
		attachments,
		correlationKey,
	});
	if (result.status === "unknown_external_state") throw new UnknownExternalStateError(`The follow-up to ${followUp.replyAddress} may have been sent: ${result.error ?? "SMTP outcome unknown"}`);
	if (result.status !== "sent") throw new Error(`The follow-up to ${followUp.replyAddress} was not sent: ${result.error ?? "SMTP failure"}`);
	await AbuseRepository.appendEvent({
		reportId: route.reportId,
		routeId: route.id,
		eventType: "provider_decision.followed_up",
		data: { state: params.state, detail: params.detail ?? null, confirmationId: run.confirmationId, to: followUp.replyAddress, narrative: reply.narrativeSource, messageId: result.rfcMessageId ?? null },
	});
	return "sent";
}

/** Read a queued follow-up's payload. */
export function readDecisionFollowUpPayload(payload: unknown): { state: string; detail?: string } {
	const record = recordValue(payload) ?? {};
	if (typeof record.state !== "string" || !record.state) throw new Error("Decision follow-up job is missing payload.state.");
	return { state: record.state, ...(typeof record.detail === "string" && record.detail ? { detail: record.detail } : {}) };
}
