import { reporterBrowserIdentity } from "../../browser/reporter_identity";
import { SubmissionsEntity } from "../../db/entities";
import { isSameWebsite } from "../../website_site";
import { errorText as describeError } from "../../error_text";
import { abuseEmailCaseUrl, sendAbuseEmailRoute } from "../mail";
import { ProviderSubmissionRejectedError, type DecisionAnswerChannel } from "../providers/submission_contracts";
import { getProviderSubmissionProvider } from "../providers";
import { AbuseRepository } from "../repository";
import { recordValue, UnknownExternalStateError } from "../worker/shared";
import { collectDecisionEvidence, type DecisionEvidence, type EvidenceFetcher } from "./evidence";
import { composeDecisionReply, type DecisionReplyInput, type NarrativeWriter } from "./reply";
import { collectWebsiteDecisionEvidence, type WebsiteDecisionEvidence, type WebsiteEvidenceDependencies } from "./website_evidence";

const MAX_ATTACHMENTS = 5;

/** Whether the reported URL is on the site its case submitted, rather than a host that site links to. */
async function isCaseSite(submissionId: bigint | null, reportedUrl: string): Promise<boolean> {
	const submission = submissionId ? await SubmissionsEntity.get(submissionId) : undefined;
	return submission?.data.kind === "website" && isSameWebsite(submission.data.website.url, reportedUrl);
}

export type DecisionFollowUpDependencies = {
	fetcher?: EvidenceFetcher;
	/** The recheck of a reported phishing site: capture, classification, stamping. */
	website?: WebsiteEvidenceDependencies;
	writeNarrative?: NarrativeWriter;
	send?: typeof sendAbuseEmailRoute;
	/** The registered provider of a route; tests answer through their own channel. */
	providerFor?: typeof getProviderSubmissionProvider;
	now?: () => Date;
	/**
	 * Build the answer without acting on it: nothing is sent and no event is
	 * recorded, so the run leaves the case as it found it. The draft, or why
	 * there would be none, goes here instead.
	 */
	dryRun?: (draft: DecisionFollowUpDraft) => void;
};

/** What a dry run of a follow-up would have done. */
export type DecisionFollowUpDraft =
	| { outcome: "reply"; replyKind: DecisionReplyInput["replyKind"]; recipient: string; subject: string; body: string; attachments: string[]; narrative: "model" | "fallback" }
	| { outcome: "not_contested"; summary: Record<string, unknown> };

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
	const provider = route && (dependencies.providerFor ?? getProviderSubmissionProvider)(route.providerRegistryKey);
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
	// A host other than the case's own site that names a User-Agent serves its
	// file only to that client (a payload host); the case's own page names the
	// browser it was captured as.
	const payloadHost = Boolean(input.report.reportedUserAgent) && !(await isCaseSite(input.report.submissionId, reportedUrl));
	const pasteCommandReport = payloadHost || input.report.allegationCategory === "malware";
	const visitor = reporterBrowserIdentity(input.report.requesterHeaders ?? undefined);
	const evidence = !pasteCommandReport && input.report.submissionId
		? await collectWebsiteDecisionEvidence({
			submissionId: input.report.submissionId,
			reportedUrl,
			...(visitor ? { visitor } : {}),
			...(decisionMessage?.occurredAt ? { reviewedAt: decisionMessage.occurredAt } : {}),
			...(caseUrl ? { caseUrl } : {}),
			...(followUp.accountIdentifiers ? { accountIdentifiers: followUp.accountIdentifiers } : {}),
		}, { ...dependencies.website, ...(dependencies.now ? { now: dependencies.now } : {}) })
		: await collectDecisionEvidence({
			observedUrl: reportedUrl,
			reportedUserAgent: input.report.reportedUserAgent,
			payloadHost,
			...(caseUrl ? { caseUrl } : {}),
			...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
			...(dependencies.now ? { now: dependencies.now } : {}),
		});
	const replyKind = replyKindFor(evidence);
	if (!replyKind) {
		if (dependencies.dryRun) {
			dependencies.dryRun({ outcome: "not_contested", summary: recheckSummary(evidence) });
			return "skipped";
		}
		await AbuseRepository.appendEvent({ reportId: route.reportId, routeId: route.id, eventType: "provider_decision.not_contested", data: { state: params.state, detail: params.detail ?? null, ...recheckSummary(evidence) } });
		return "skipped";
	}

	const reply = await composeDecisionReply({
		providerName: followUp.addressee,
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
	const { channel } = followUp;
	const recipient = channel.kind === "email" ? channel.replyAddress : channel.name;
	const subject = channel.kind === "email" ? channel.subject(run.confirmationId) : `Additional evidence for ${followUp.addressee} report ${run.confirmationId}`;
	if (dependencies.dryRun) {
		dependencies.dryRun({ outcome: "reply", replyKind, recipient, subject, body: reply.body, attachments: attachments.map((attachment) => attachment.filename), narrative: reply.narrativeSource });
		return "skipped";
	}
	const answer = { route, runId: run.id, confirmationId: run.confirmationId, subject, body: reply.body, attachments, correlationKey };
	const messageId = channel.kind === "email"
		? await answerByMail({ ...answer, recipient }, dependencies.send ?? sendAbuseEmailRoute)
		: await answerThroughForm({ ...answer, channel });
	await AbuseRepository.appendEvent({
		reportId: route.reportId,
		routeId: route.id,
		eventType: "provider_decision.followed_up",
		data: { state: params.state, detail: params.detail ?? null, confirmationId: run.confirmationId, to: recipient, replyKind, narrative: reply.narrativeSource, messageId },
	});
	return "sent";
}

type Answer = {
	route: { id: bigint; reportId: bigint };
	runId: bigint;
	confirmationId: string;
	subject: string;
	body: string;
	attachments: Array<{ filename: string; mimeType: string; content: Buffer }>;
	correlationKey: string;
};

/** Mail the answer; its outbound record, under the follow-up's correlation key, keeps it from being sent twice. */
async function answerByMail(answer: Answer & { recipient: string }, send: typeof sendAbuseEmailRoute): Promise<string | null> {
	const result = await send({
		routeId: answer.route.id,
		runId: answer.runId,
		reportId: answer.route.reportId,
		recipient: answer.recipient,
		subject: answer.subject,
		body: answer.body,
		attachments: answer.attachments,
		correlationKey: answer.correlationKey,
	});
	if (result.status === "unknown_external_state") throw new UnknownExternalStateError(`The follow-up to ${answer.recipient} may have been sent: ${result.error ?? "SMTP outcome unknown"}`);
	if (result.status !== "sent") throw new Error(`The follow-up to ${answer.recipient} was not sent: ${result.error ?? "SMTP failure"}`);
	return result.rfcMessageId ?? null;
}

/**
 * File the answer through the provider's form. Its record is written right
 * before the request that files it, under the follow-up's correlation key:
 * a failure before that is retried by the job, a failure of that request is
 * never repeated, and a named refusal settles the record as failed.
 */
async function answerThroughForm(answer: Answer & { channel: Extract<DecisionAnswerChannel, { kind: "form" }> }): Promise<string> {
	let recorded: bigint | undefined;
	const markSending = async () => {
		recorded = await AbuseRepository.createOutboundProviderMessage({
			reportId: answer.route.reportId,
			routeId: answer.route.id,
			runId: answer.runId,
			to: answer.channel.name,
			subject: answer.subject,
			textBody: answer.body,
			correlationKey: answer.correlationKey,
		});
	};
	try {
		await answer.channel.submit({ confirmationId: answer.confirmationId, body: answer.body, attachments: answer.attachments }, markSending);
	} catch (error) {
		if (recorded === undefined) throw error;
		if (error instanceof ProviderSubmissionRejectedError) {
			await AbuseRepository.settleOutboundMail({ messageId: recorded, status: "failed", error: describeError(error) });
			throw error;
		}
		throw new UnknownExternalStateError(`The answer through ${answer.channel.name} may have been filed: ${describeError(error)}`);
	}
	if (recorded === undefined) throw new Error(`${answer.channel.name} filed the answer without recording it first.`);
	await AbuseRepository.settleOutboundMail({ messageId: recorded, status: "sent" });
	return recorded.toString();
}

/** Read a queued follow-up's payload. */
export function readDecisionFollowUpPayload(payload: unknown): { state: string; detail?: string } {
	const record = recordValue(payload) ?? {};
	if (typeof record.state !== "string" || !record.state) throw new Error("Decision follow-up job is missing payload.state.");
	return { state: record.state, ...(typeof record.detail === "string" && record.detail ? { detail: record.detail } : {}) };
}
