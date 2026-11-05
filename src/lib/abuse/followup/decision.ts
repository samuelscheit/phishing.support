import { abuseEmailCaseUrl, sendAbuseEmailRoute } from "../mail";
import { getProviderSubmissionProvider } from "../providers";
import { AbuseRepository } from "../repository";
import { recordValue, UnknownExternalStateError } from "../worker/shared";
import { collectDecisionEvidence, type DecisionEvidence, type EvidenceFetcher } from "./evidence";
import { composeDecisionReply, type DecisionReplyInput, type NarrativeWriter } from "./reply";
import { collectWebsiteDecisionEvidence, type WebsiteDecisionEvidence, type WebsiteEvidenceDependencies } from "./website_evidence";

const MAX_ATTACHMENTS = 5;

export type DecisionFollowUpDependencies = {
	fetcher?: EvidenceFetcher;
	/** The recheck of a reported phishing site: capture, classification, stamping. */
	website?: WebsiteEvidenceDependencies;
	writeNarrative?: NarrativeWriter;
	send?: typeof sendAbuseEmailRoute;
	now?: () => Date;
};

/** The provider's own message about its decision: the newest provider-API mail that is not a status record. */
function providerDecisionMessage(messages: Awaited<ReturnType<typeof AbuseRepository.listMailForReport>>, routeId: bigint) {
	return messages
		.filter((message) => message.routeId === routeId && message.direction === "inbound" && !message.correlationKey?.includes(":status:") && !/confirmation/i.test(message.subject ?? ""))
		.at(-1);
}

/**
 * Whether and how to answer, from what the recheck measured. A paste-command
 * page is contested while our server still receives it. A phishing site is
 * contested while it still serves the kit, or when our capture after the
 * review shows it was visible then; once it is gone everywhere, identifiers
 * that tie it to an account at the provider still warrant asking them to act
 * on that account. Anything else the provider may be right about.
 */
function replyKindFor(evidence: DecisionEvidence | WebsiteDecisionEvidence): DecisionReplyInput["replyKind"] | undefined {
	if (evidence.kind === "paste_command") {
		return evidence.liveChecks.some((check) => check.status === 200 && (check.as === "the command's own downloader" || evidence.command)) ? "contest" : undefined;
	}
	if (evidence.stillServed) return "contest";
	if (!evidence.recheck.reached && evidence.accountIdentifiers.length) return "account";
	if (evidence.capture?.afterReview) return "contest";
	return undefined;
}

/** What a not-contested decision records about the recheck, without the screenshot. */
function recheckSummary(evidence: DecisionEvidence | WebsiteDecisionEvidence) {
	if (evidence.kind === "paste_command") return { liveChecks: evidence.liveChecks };
	const { freshScreenshot: _, ...summary } = evidence;
	return { recheck: summary };
}

/**
 * Answer a provider that reviewed a filed report and found nothing (or found
 * it gone), once per route and decision. The reply restates a fresh recheck
 * and what a reviewer needs to see the content: reproduction steps for a
 * paste-command page, the cloaking and routes for a phishing site. A decision
 * the recheck supports is not contested.
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
	const decisionMessage = providerDecisionMessage(mail, route.id);

	const caseUrl = abuseEmailCaseUrl(input.report.submissionId);
	// A phishing site from a case is rechecked as the case captured it; a
	// paste-command page or payload host is fetched as its visitors fetch it.
	const pasteCommandReport = Boolean(input.report.reportedUserAgent) || input.report.allegationCategory === "malware";
	const evidence = !pasteCommandReport && input.report.submissionId
		? await collectWebsiteDecisionEvidence({
			submissionId: input.report.submissionId,
			reportedUrl,
			...(decisionMessage?.occurredAt ? { reviewedAt: decisionMessage.occurredAt } : {}),
			...(caseUrl ? { caseUrl } : {}),
			...(followUp.accountIdentifiers ? { accountIdentifiers: followUp.accountIdentifiers } : {}),
		}, { ...dependencies.website, ...(dependencies.now ? { now: dependencies.now } : {}) })
		: await collectDecisionEvidence({
			observedUrl: reportedUrl,
			reportedUserAgent: input.report.reportedUserAgent,
			...(caseUrl ? { caseUrl } : {}),
			...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
			...(dependencies.now ? { now: dependencies.now } : {}),
		});
	const replyKind = replyKindFor(evidence);
	if (!replyKind) {
		await AbuseRepository.appendEvent({ reportId: route.reportId, routeId: route.id, eventType: "provider_decision.not_contested", data: { state: params.state, detail: params.detail ?? null, ...recheckSummary(evidence) } });
		return "skipped";
	}

	const reply = await composeDecisionReply({
		providerName: provider.definition.displayName.replace(/\s+Abuse$/i, ""),
		confirmationId: run.confirmationId,
		decision: { state: params.state, ...(params.detail ? { detail: params.detail } : {}), ...(decisionMessage?.textBody ? { providerMessage: decisionMessage.textBody } : {}) },
		allegationCategory: input.report.allegationCategory,
		target: target.normalizedTarget,
		reportedUrl,
		description: input.report.description,
		replyKind,
		evidence,
	}, dependencies.writeNarrative);

	const fresh = evidence.kind === "website" && evidence.freshScreenshot
		? [{ filename: evidence.freshScreenshot.filename, mimeType: "image/png", content: evidence.freshScreenshot.png }]
		: [];
	const attachments = [
		...fresh,
		...input.evidenceArtifacts.slice(0, MAX_ATTACHMENTS - fresh.length).map((artifact) => ({ filename: artifact.name, mimeType: artifact.mimeType, content: Buffer.from(artifact.blob) })),
	];
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
		data: { state: params.state, detail: params.detail ?? null, confirmationId: run.confirmationId, to: followUp.replyAddress, replyKind, narrative: reply.narrativeSource, messageId: result.rfcMessageId ?? null },
	});
	return "sent";
}

/** Read a queued follow-up's payload. */
export function readDecisionFollowUpPayload(payload: unknown): { state: string; detail?: string } {
	const record = recordValue(payload) ?? {};
	if (typeof record.state !== "string" || !record.state) throw new Error("Decision follow-up job is missing payload.state.");
	return { state: record.state, ...(typeof record.detail === "string" && record.detail ? { detail: record.detail } : {}) };
}
