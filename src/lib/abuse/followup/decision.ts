import { reporterBrowserIdentity } from "../../browser/reporter_identity";
import { SubmissionsEntity } from "../../db/entities/submissions";
import { errorText as describeError } from "../../error_text";
import { abuseEmailCaseUrl } from "../mail/draft";
import { sendAbuseEmailRoute } from "../mail/send";
import { getProviderSubmissionProvider } from "../providers";
import { ProviderSubmissionRejectedError, type DecisionAnswerChannel } from "../providers/submission_contracts";
import { AbuseRepository } from "../repository";
import { UnknownExternalStateError } from "../worker/shared";
import { runDecisionAgent, type DecisionAgentModel, type DecisionAgentOutcome, type DecisionAgentStep } from "./agent";
import { checkReportedSites, reasonSaysContentGone, takedownConfirmed } from "./liveness";
import { caseCaptureNames, type AttachableFile, type DecisionToolDependencies } from "./tools";
import { asRecord } from "../../values";
import { accessGateOf, arrivalChain } from "../../website/access_gate";

const MAX_MESSAGE_TEXT = 6_000;

export type DecisionFollowUpDependencies = {
	/** The agent's model; tests script it. */
	model?: DecisionAgentModel;
	/** The tools' browser capture and network; tests replace them. */
	tools?: DecisionToolDependencies;
	send?: typeof sendAbuseEmailRoute;
	/** The registered provider of a route; tests answer through their own channel. */
	providerFor?: typeof getProviderSubmissionProvider;
	now?: () => Date;
	/** The job's deadline: the agent and its site visits stop when it fires. */
	signal?: AbortSignal;
	/**
	 * Run the agent without acting on its decision: nothing is sent and
	 * nothing is recorded, so the case is left as it was found.
	 */
	dryRun?: (draft: { outcome: DecisionAgentOutcome; steps: DecisionAgentStep[]; recipient: string }) => void;
};

/**
 * Answer a provider's review decision when an agent finds that answering
 * helps. The agent gets the decision, our report, the case and every message
 * on the route; it investigates with a real browser, plain requests, the
 * case's own captures and web search, then either writes the answer, sent
 * exactly as written through the provider's channel, or decides to send
 * nothing. Either way its reason and every step it took are kept with the
 * case. One answer at most per route and decision.
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
	if (!input || !target) return "skipped";

	const correlationKey = `decision-follow-up:${route.id.toString()}:${params.state}`;
	const mail = await AbuseRepository.listMailForReport(route.reportId);
	if (mail.some((message) => message.direction === "outbound" && message.correlationKey === correlationKey)) return "skipped";
	if ((await AbuseRepository.listEvents(route.reportId)).some((event) => event.routeId === route.id && event.eventType === "provider_decision.not_answered" && asRecord(event.data)?.state === params.state)) return "skipped";

	// Our own look at the site, before anyone is contradicted: a provider that says the content is gone,
	// about a site the registry or host took down, is right.
	const liveness = await checkReportedSites(target, { ...dependencies.tools, ...(dependencies.signal ? { signal: dependencies.signal } : {}) });
	if (reasonSaysContentGone(params.detail) && takedownConfirmed(liveness)) {
		const reason = `The provider's decision is confirmed by our own check: ${liveness.map((check) => `${check.url} is ${check.state} (${check.detail})`).join("; ")}.`;
		if (dependencies.dryRun) {
			dependencies.dryRun({ outcome: { kind: "do_not_answer", reason }, steps: [], recipient: followUp.channel.kind === "email" ? followUp.channel.replyAddress : followUp.channel.name });
			return "skipped";
		}
		await AbuseRepository.appendEvent({ reportId: route.reportId, routeId: route.id, eventType: "provider_decision.not_answered", data: { state: params.state, detail: params.detail ?? null, reason, confirmedByLiveness: true, liveness } });
		return "skipped";
	}

	const { channel } = followUp;
	const recipient = channel.kind === "email" ? channel.replyAddress : channel.name;
	const subject = channel.kind === "email" ? channel.subject(run.confirmationId) : `Additional evidence for ${followUp.addressee} report ${run.confirmationId}`;
	const submissionId = input.report.submissionId ?? undefined;
	const submission = submissionId === undefined ? undefined : await SubmissionsEntity.get(submissionId);
	const website = submission?.data.kind === "website" ? submission.data.website : undefined;
	const caseUrl = abuseEmailCaseUrl(input.report.submissionId);
	const attachable = new Map<string, AttachableFile>(input.evidenceArtifacts.map((artifact) => [artifact.name, { filename: artifact.name, mimeType: artifact.mimeType, content: Buffer.from(artifact.blob) }]));
	const visitor = reporterBrowserIdentity(input.report.requesterHeaders ?? undefined);
	// From the link first submitted: a case handed off from a redirecting site starts at its entry.
	const arrival = submissionId === undefined ? [] : await arrivalChain(submissionId);
	const capturedUrl = website && (arrival.find((hop) => hop.contentCaptured)?.url ?? website.archiveUrl ?? website.url);

	const context = {
		now: (dependencies.now ?? (() => new Date()))().toISOString(),
		we: "phishing.support (support@phishing.support, https://phishing.support)",
		provider: followUp.addressee,
		channel: channel.kind === "email"
			? { kind: "email", to: channel.replyAddress, subject }
			: { kind: "form", name: channel.name, ...(channel.requirements ? { requirements: channel.requirements } : {}) },
		decision: { state: params.state, reason: params.detail ?? null },
		// Our own check of the reported URLs just now. A suspended or undelegated domain is down whatever a stale resolver still says.
		liveness: liveness.map(({ url, state, detail, domainStatuses, resolvedAddresses }) => ({ url, state, detail, registryStatuses: domainStatuses, resolvedAddresses })),
		report: {
			receipt: run.confirmationId,
			filedAt: run.createdAt.toISOString(),
			allegation: input.report.allegationCategory,
			target: target.normalizedTarget,
			reportedUrls: target.observedUrls,
			textWeFiled: input.report.description,
			reportedUserAgent: input.report.reportedUserAgent ?? null,
			impersonatedBrandSite: input.report.legalBrandUrl ?? null,
		},
		case: {
			url: caseUrl ?? null,
			...(website ? {
				submittedUrl: website.url,
				capturedUrl: website.archiveUrl ?? null,
				findings: (website.siteAssessments ?? []).filter((assessment) => assessment.finding === "phishing" || assessment.finding === "malware"),
				cloaking: website.cloaking ?? null,
				device: website.device ?? null,
				navigation: arrival.map(({ url, status, redirectTo, visitorStep }) => ({ url, status, redirectTo: redirectTo ?? null, ...(visitorStep ? { passedPageOfItsOwn: true } : {}) })),
				// Cases reported before the gate was kept with them have it read from their arrival.
				accessGate: website.accessGate ?? (capturedUrl ? accessGateOf(arrival, capturedUrl) : undefined) ?? null,
				visit: website.visit?.report ?? null,
			} : {}),
		},
		correspondence: mail.filter((message) => message.routeId === route.id).map((message) => ({
			direction: message.direction,
			from: message.fromAddress,
			to: message.toAddresses,
			at: message.occurredAt.toISOString(),
			subject: message.subject,
			text: message.textBody?.slice(0, MAX_MESSAGE_TEXT) ?? null,
		})),
		caseCaptures: await caseCaptureNames(submissionId),
		attachableFiles: [...attachable.values()].map(({ filename, mimeType }) => ({ name: filename, mimeType })),
	};

	const { outcome, steps } = await runDecisionAgent({
		context,
		tools: {
			...(submissionId !== undefined ? { submissionId } : {}),
			...(caseUrl ? { caseUrl } : {}),
			...(visitor ? { visitor } : {}),
			...(website?.device ? { device: website.device } : {}),
			...(followUp.accountIdentifiers ? { accountIdentifiers: followUp.accountIdentifiers } : {}),
			attachable,
		},
		...(dependencies.model ? { model: dependencies.model } : {}),
		dependencies: { ...dependencies.tools, ...(dependencies.signal ? { signal: dependencies.signal } : {}) },
	});
	if (dependencies.dryRun) {
		dependencies.dryRun({ outcome, steps, recipient });
		return "skipped";
	}
	await AbuseRepository.saveArtifact({
		reportId: route.reportId,
		routeId: route.id,
		runId: run.id,
		name: `decision-follow-up-${params.state.replace(/[^a-z0-9]+/gi, "-")}.json`,
		kind: "decision_follow_up_transcript",
		mimeType: "application/json",
		buffer: Buffer.from(JSON.stringify({ decision: params, outcome, steps }, null, 2), "utf8"),
	});
	if (outcome.kind === "do_not_answer") {
		await AbuseRepository.appendEvent({ reportId: route.reportId, routeId: route.id, eventType: "provider_decision.not_answered", data: { state: params.state, detail: params.detail ?? null, reason: outcome.reason } });
		return "skipped";
	}

	const attachments = outcome.attachments.map((name) => attachable.get(name)).filter((file): file is AttachableFile => file !== undefined);
	const answer = { route, runId: run.id, confirmationId: run.confirmationId, subject, body: outcome.text, attachments, correlationKey };
	const messageId = channel.kind === "email"
		? await answerByMail({ ...answer, recipient }, dependencies.send ?? sendAbuseEmailRoute)
		: await answerThroughForm({ ...answer, channel });
	await AbuseRepository.appendEvent({
		reportId: route.reportId,
		routeId: route.id,
		eventType: "provider_decision.followed_up",
		data: { state: params.state, detail: params.detail ?? null, confirmationId: run.confirmationId, to: recipient, summary: outcome.summary, messageId },
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
	const record = asRecord(payload) ?? {};
	if (typeof record.state !== "string" || !record.state) throw new Error("Decision follow-up job is missing payload.state.");
	return { state: record.state, ...(typeof record.detail === "string" && record.detail ? { detail: record.detail } : {}) };
}
