import { reporterBrowserIdentity } from "../../browser/reporter_identity";
import { SubmissionsEntity } from "../../db/entities/submissions";
import { abuseEmailCaseUrl } from "../mail/draft";
import type { sendAbuseEmailRoute } from "../mail/send";
import { getProviderSubmissionProvider } from "../providers";
import { AbuseRepository } from "../repository";
import { runDecisionAgent, type DecisionAgentModel, type DecisionAgentOutcome, type DecisionAgentStep } from "./agent";
import { messageByMail, messageThroughForm } from "./route_notice";
import { checkReportedSites, takedownConfirmed } from "./liveness";
import { verifyReportedContent, type ContentVerification } from "../../liveness/content";
import type { SiteCheckResult } from "../../liveness/check";
import { caseCaptureNames, type AttachableFile, type DecisionToolDependencies } from "./tools";
import { asRecord } from "../../util/values";
import { accessGateOf } from "../../website/visit/access_gate";
import { analyzedPage } from "../../website/visit/capture_files";
import { isSameWebsite, websiteSite } from "../../website/info/site";
import { reportedSiteRoute, websiteRoutes } from "../../website/routes";

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

	// Our own look at the site, before anyone is contradicted: a site the registry or host took down needs no answer.
	const tools = { ...dependencies.tools, ...(dependencies.signal ? { signal: dependencies.signal } : {}) };
	const liveness = await checkReportedSites(target, tools);
	if (takedownConfirmed(liveness)) {
		const reason = `The provider's decision is confirmed by our own check: ${liveness.map((check) => `${check.url} is ${check.state} (${check.detail})`).join("; ")}.`;
		if (dependencies.dryRun) {
			dependencies.dryRun({ outcome: { kind: "do_not_answer", reason }, steps: [], recipient: followUp.channel.kind === "email" ? followUp.channel.replyAddress : followUp.channel.name });
			return "skipped";
		}
		await AbuseRepository.appendEvent({ reportId: route.reportId, routeId: route.id, eventType: "provider_decision.not_answered", data: { state: params.state, detail: params.detail ?? null, reason, confirmedByLiveness: true, liveness } });
		return "skipped";
	}
	const verification = await verifyContent(route, target, liveness, tools, dependencies.signal);

	const { channel } = followUp;
	const recipient = channel.kind === "email" ? channel.replyAddress : channel.name;
	const subject = channel.kind === "email" ? channel.subject(run.confirmationId) : `Additional evidence for ${followUp.addressee} report ${run.confirmationId}`;
	const submissionId = input.report.submissionId ?? undefined;
	const submission = submissionId === undefined ? undefined : await SubmissionsEntity.get(submissionId);
	const website = submission?.data.kind === "website" ? submission.data.website : undefined;
	const caseUrl = abuseEmailCaseUrl(input.report.submissionId);
	const attachable = new Map<string, AttachableFile>(input.evidenceArtifacts.map((artifact) => [artifact.name, { filename: artifact.name, mimeType: artifact.mimeType, content: Buffer.from(artifact.blob) }]));
	const visitor = reporterBrowserIdentity(input.report.requesterHeaders ?? undefined);
	// The reported page is the first URL the report names; its chain is the whole route that reached it, from the link first submitted.
	const capturedUrl = website && (target.observedUrls[0] ?? analyzedPage(website)?.hop.url ?? website.url);
	const caseRoute = website && websiteRoutes(website)[(capturedUrl ? reportedSiteRoute(website, websiteSite(capturedUrl))?.route : undefined) ?? website.analyzedRoute ?? 0];
	const chain = caseRoute?.hops ?? [];
	// The gate kept with the case, with its direct visit, is that of the page it was checked for; any other page's is read from the chain.
	const keptGate = website?.accessGate?.bareVisit && website.accessGate.bareVisit.url === capturedUrl ? website.accessGate : undefined;

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
		// Whether the reported URL serves now what the case recorded, compared by hash.
		contentVerification: verificationContext(verification),
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
				capturedUrl: capturedUrl ?? null,
				// The findings of the reported site; other sites of the chain have reports of their own.
				findings: (caseRoute?.siteAssessments ?? []).filter((assessment) => (assessment.finding === "phishing" || assessment.finding === "malware")
					&& capturedUrl !== undefined && chain.some((hop) => hop.index === assessment.hopIndex && isSameWebsite(hop.url, capturedUrl))),
				cloaking: website.cloaking ?? null,
				device: website.device ?? null,
				navigation: chain.map(({ url, status, redirectTo, visitorStep }) => ({ url, status, redirectTo: redirectTo ?? null, ...(visitorStep ? { passedPageOfItsOwn: true } : {}) })),
				accessGate: keptGate ?? (capturedUrl ? accessGateOf(chain, capturedUrl) : undefined) ?? null,
				visit: caseRoute?.visit?.report ?? null,
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
		? await messageByMail({ ...answer, recipient }, dependencies.send)
		: await messageThroughForm({ ...answer, channel });
	await AbuseRepository.appendEvent({
		reportId: route.reportId,
		routeId: route.id,
		eventType: "provider_decision.followed_up",
		data: { state: params.state, detail: params.detail ?? null, confirmationId: run.confirmationId, to: recipient, summary: outcome.summary, messageId },
	});
	return "sent";
}

/** The reported URL's content compared with the case's: plain requests first, then a browser like the case's. The agent itself judges what changed. */
async function verifyContent(
	route: { reportId: bigint; targetId: bigint },
	target: { observedUrls: readonly string[]; normalizedTarget: string },
	liveness: readonly SiteCheckResult[],
	tools: NonNullable<DecisionFollowUpDependencies["tools"]>,
	signal: AbortSignal | undefined,
): Promise<ContentVerification> {
	const url = target.observedUrls.find((candidate) => /^https?:\/\//i.test(candidate)) ?? `https://${target.normalizedTarget}/`;
	const check = liveness.find((result) => result.url === url);
	return verifyReportedContent({ reportId: route.reportId, targetId: route.targetId, url }, { maxTier: "browser", ...(signal ? { signal } : {}) }, {
		...(check ? { check } : {}),
		// The same requests as the liveness check of every reported URL.
		site: {
			...(tools.fetch ? { fetch: tools.fetch } : {}),
			...(tools.assertPublicHost ? { assertPublicHost: tools.assertPublicHost } : {}),
			...tools.liveness,
		},
		...(tools.capture ? { capture: tools.capture } : {}),
	});
}

function verificationContext(verification: ContentVerification) {
	const { url, verdict, tier } = verification;
	return {
		url,
		verdict,
		by: tier,
		...(verification.verdict === "served" ? { matches: verification.matches } : {}),
		...(verification.verdict === "unverified" ? { reason: verification.reason } : {}),
	};
}

/** Read a queued follow-up's payload. */
export function readDecisionFollowUpPayload(payload: unknown): { state: string; detail?: string } {
	const record = asRecord(payload) ?? {};
	if (typeof record.state !== "string" || !record.state) throw new Error("Decision follow-up job is missing payload.state.");
	return { state: record.state, ...(typeof record.detail === "string" && record.detail ? { detail: record.detail } : {}) };
}
