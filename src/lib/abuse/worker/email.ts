import { abuseEmailCaseUrl, createAbuseEmailDraft, hostingAddress, readVerifiedEmailDraft, type AbuseEmailDraft, verifiedEmailProviderPayload } from "../mail/draft";
import { isSafeEmailDeliveryFailure, ROUTE_MAIL_ATTACHMENT_KINDS } from "../mail/types";
import { buildXarfReport, xarfAttachment, xarfMessageOf } from "../mail/xarf";
import { getProviderSubmissionProviderForMailbox } from "../providers";
import { attachmentsAsText, refusesAttachedFiles } from "../mail/attachment_policy";
import { sendAbuseEmailRoute } from "../mail/send";
import { smtpRelay } from "../../mail/config";
import { serviceIdentity } from "../../network/service_identity";
import { approvalDraftOf } from "../persistence/approvals";
import { AbuseRepository } from "../repository";
import { boundedErrorText } from "../../util/error_text";
import { RetryableDeliveryError, routeContext, UnknownExternalStateError, type WorkerServices } from "./shared";
import { DAY_MS } from "../../util/date_time";
import { accessStepUrls } from "../../website/visit/access_steps_text";
import { isDown } from "../../liveness/layer";
import { listSiteChecksForTargets } from "../../liveness/repository";
import type { AbuseProviderRoute } from "../schema";

/**
 * A report our relay refused (mail/relay_refusal.ts) never reached the
 * provider. It is sent once more through each relay (`SMTP_HOST`), unless its
 * site is already down: right after a refusal, since a filtering relay may
 * accept the next attempt, and once the relay changes, for every route whose
 * last attempt the old relay refused. A relay that refuses it twice ends it
 * until the relay changes.
 */
export async function queueRelayResend(route: AbuseProviderRoute): Promise<void> {
	const relay = smtpRelay();
	if (!relay) return;
	const latest = (await listSiteChecksForTargets([route.targetId])).at(-1);
	if (latest && isDown(latest.state)) return;
	await AbuseRepository.enqueueJobOnce({
		jobType: "send_email",
		reportId: route.reportId,
		routeId: route.id,
		payload: { retryReason: "relay_refused", relay },
		dedupeKey: `relay-resend:${route.id.toString()}:${relay}`,
	});
}

/** At worker start: the resend due through the current relay of every route a relay refused. */
export async function ensureRelayRefusalResends(): Promise<void> {
	for (const route of await AbuseRepository.listRelayRefusedRoutes()) await queueRelayResend(route);
}

type EmailWorkerServices = Pick<WorkerServices, "markUnknownExternal"> & {
	/** Injectable for deterministic worker tests; production uses the canonical draft builder. */
	createDraft?: typeof createAbuseEmailDraft;
	/** Injectable for deterministic worker tests; production uses the canonical SMTP boundary. */
	send?: typeof sendAbuseEmailRoute;
};

/**
 * How a send job sends: `redraft` is the resend after our relay refused the
 * report (queueRelayResend), `attachmentsAsText` the resend after the
 * recipient's server refused an attached file (mail/attachment_policy.ts).
 */
export type SendEmailOptions = { redraft?: boolean; attachmentsAsText?: boolean };

export function readSendEmailPayload(payload: Record<string, unknown> | null | undefined): SendEmailOptions {
	if (payload?.retryReason === "relay_refused") return { redraft: true };
	if (payload?.retryReason === "attachment_refused") return { attachmentsAsText: true };
	return {};
}

export async function sendEmail(routeId: bigint, worker: EmailWorkerServices, options: SendEmailOptions = {}): Promise<void> {
	const { route, report, target, evidenceArtifacts, accessSteps } = await routeContext(routeId);
	if (route.routeType !== "email" || !route.verifiedEmail) return;
	if (route.status === "running") {
		// A stale/replayed job can observe the route after the durable email run
		// was claimed but before SMTP settlement. There is no safe way to infer
		// whether DATA crossed the provider boundary, so fail closed instead of
		// silently completing the job and leaving the route stranded in `running`.
		const activeRun = await AbuseRepository.getLatestActiveProviderRunForRoute(route.id);
		const message = "Email delivery was interrupted after its durable run record was created; delivery reconciliation is required before retrying.";
		await worker.markUnknownExternal({ routeId: route.id, runId: activeRun?.id, error: message, reason: "outbound_delivery_interrupted" });
		throw new UnknownExternalStateError(message);
	}
	if (!["verified", "delivery_failed"].includes(route.status)) return;
	const correlationKey = `email-run:${route.id.toString()}`;
	const caseUrl = abuseEmailCaseUrl(report.submissionId);
	const allowedDraftUrls = [
		serviceIdentity.url,
		...target.observedUrls,
		...(report.legalBrandUrl ? [report.legalBrandUrl] : []),
		...(caseUrl ? [caseUrl] : []),
		// The pages the access steps are done on, and the addresses they open.
		...accessStepUrls(accessSteps),
		...(approvalDraftOf(route)?.allowedUrls ?? []),
	];
	const routeArtifacts = await AbuseRepository.listRouteArtifacts(route.id, ROUTE_MAIL_ATTACHMENT_KINDS);
	const evidence = [...routeArtifacts, ...evidenceArtifacts]
		.filter((artifact, index, all) => all.findIndex((candidate) => candidate.id === artifact.id) === index)
		.slice(0, 15)
		.map((artifact) => ({ filename: artifact.name, mimeType: artifact.mimeType, content: artifact.blob }));
	const asText = options.attachmentsAsText || refusesAttachedFiles(route.verifiedEmail);
	const asSent = (files: typeof evidence) => asText ? attachmentsAsText(files) : files;
	const attachments = asSent(evidence);
	let draft: AbuseEmailDraft | undefined;
	let providerPayload: Record<string, unknown>;
	// A resend after our relay refused the report is drafted anew: the provider never received the
	// first one, and a report drafted before the case tag and hosting address existed went out without them.
	if (route.status === "delivery_failed" && !options.redraft) {
		const existing = await AbuseRepository.getProviderRunByCorrelationKey(correlationKey);
		const persisted = existing && readVerifiedEmailDraft(existing.providerPayload, {
			recipient: route.verifiedEmail,
			description: report.description,
			target: target.normalizedTarget,
			observedUrls: target.observedUrls,
			allowedUrls: allowedDraftUrls,
		});
		if (!existing || !persisted) {
			const message = "The durable email draft is missing or unsafe to resend; automatic SMTP delivery was stopped.";
			await worker.markUnknownExternal({ routeId: route.id, runId: existing?.id, error: message, reason: "email_draft_integrity_failure" });
			throw new UnknownExternalStateError(message);
		}
		draft = persisted;
		providerPayload = existing.providerPayload;
	} else {
		draft = await (worker.createDraft ?? createAbuseEmailDraft)({
			report,
			target,
			route,
			recipient: route.verifiedEmail,
			attachmentNames: attachments.map((attachment) => attachment.filename),
			attachmentMimeTypes: attachments.map((attachment) => attachment.mimeType),
			evidence: attachments,
			...(accessSteps ? { accessSteps } : {}),
		});
		providerPayload = verifiedEmailProviderPayload({
			target: target.normalizedTarget,
			observedUrls: target.observedUrls,
			recipient: route.verifiedEmail,
			email: draft,
		});
	}
	// Every report with an XARF type carries it as xarf.json beside its files, for desks
	// whose tooling reads XARF. A mailbox whose provider names XARF as its mail format is
	// run by tooling that reads nothing else: its mail is the XARF report, files inside.
	const xarfOnly = getProviderSubmissionProviderForMailbox(route.verifiedEmail)?.definition.emailFallback?.format === "xarf";
	const sourceIp = hostingAddress(route, target);
	const message = await xarfMessageOf(evidence);
	const xarf = buildXarfReport({
		reportId: crypto.randomUUID(),
		allegationCategory: report.allegationCategory,
		observedAt: report.createdAt,
		target: target.normalizedTarget,
		observedUrls: target.observedUrls,
		...(sourceIp ? { sourceIp } : {}),
		legalBrandUrl: report.legalBrandUrl,
		description: draft.subject,
		...(caseUrl ? { caseUrl } : {}),
		...(message ? { message } : {}),
		...(xarfOnly ? { evidence } : {}),
	});
	const sentAttachments = xarf && !xarfOnly ? [...attachments, ...asSent([xarfAttachment(xarf)])] : attachments;
	const delivery = await AbuseRepository.beginEmailDelivery({
		routeId: route.id,
		correlationKey,
		providerPayload,
	});
	if (!delivery) return;
	const run = delivery.run;
	// A delivery retry uses the draft the run holds: the first attempt's for a
	// plain retry, so recipient-facing prose is never regenerated once a
	// provider may have read it.
	const persistedDraft = readVerifiedEmailDraft(run.providerPayload, {
		recipient: route.verifiedEmail,
		description: report.description,
		target: target.normalizedTarget,
		observedUrls: target.observedUrls,
		allowedUrls: allowedDraftUrls,
	});
	if (!persistedDraft) {
		const message = "The durable email draft is missing or unsafe to resend; automatic SMTP delivery was stopped.";
		await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "email_draft_integrity_failure" });
		throw new UnknownExternalStateError(message);
	}
	let retryReplyAddress: string | undefined;
	if (!delivery.created) {
		const outbound = await AbuseRepository.getOutboundMailForRun(run.id);
		if (delivery.previousDeliveryFailed && outbound?.status === "failed") {
			// SMTP explicitly reported the prior delivery failure. Retrying that
			// outcome is safe only with the same durable correlation/reply identity.
			retryReplyAddress = outbound.replyAddress ?? undefined;
		} else {
			const message = "Email delivery was interrupted after its durable run record was created; resend is unsafe without delivery reconciliation.";
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "outbound_delivery_interrupted" });
			throw new UnknownExternalStateError(message);
		}
	}
	let result: Awaited<ReturnType<typeof sendAbuseEmailRoute>>;
	try {
		result = await (worker.send ?? sendAbuseEmailRoute)({
			routeId: route.id,
			runId: run.id,
			reportId: report.id,
			recipient: route.verifiedEmail,
			subject: persistedDraft.subject,
			body: persistedDraft.body,
			attachments: sentAttachments,
			correlationKey,
			replyAddress: retryReplyAddress,
			...(xarf && xarfOnly ? { xarf } : {}),
		});
	} catch (error) {
		// MIME construction, local artifact persistence, and outbound-message
		// persistence all happen before SMTP. Those failures are therefore
		// safely retryable, but only after the claimed route/run are atomically
		// returned to the known delivery-failed state. Do not let a normal job
		// retry strand this route in `running`.
		const failure = boundedErrorText(error);
		if (isSafeEmailDeliveryFailure(error) && await AbuseRepository.recoverEmailPreparationFailure({ runId: run.id, error: failure })) {
			throw new RetryableDeliveryError(failure);
		}

		// A correlated bounce can settle the same run between local persistence
		// and this catch block. That is a stronger, known outcome; leave its
		// durable retry job in charge instead of downgrading it to an ambiguity.
		const [currentRun, currentRoute] = await Promise.all([
			AbuseRepository.getProviderRun(run.id),
			AbuseRepository.getRoute(route.id),
		]);
		if (currentRun?.executionStatus === "failed" && currentRoute?.status === "delivery_failed") return;

		const message = `Email delivery failed after the route was claimed but could not be safely recovered: ${failure}`;
		await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "email_preparation_recovery_conflict" });
		throw new UnknownExternalStateError(message);
	}
	if (result.status === "sent") {
		const settled = await AbuseRepository.settleEmailDelivery({
			runId: run.id,
			expectedRunStatus: "starting",
			expectedRouteStatus: "running",
			outcome: "sent",
		});
		if (settled) {
			await AbuseRepository.enqueueJob({ jobType: "monitor_provider_reply", reportId: report.id, routeId: route.id, runId: run.id, payload: {}, dedupeKey: `monitor:${run.id.toString()}`, nextAttemptAt: new Date(Date.now() + DAY_MS) });
		} else {
			const [currentRun, currentRoute] = await Promise.all([
				AbuseRepository.getProviderRun(run.id),
				AbuseRepository.getRoute(route.id),
			]);
			if (currentRun?.executionStatus === "delivered" && ["awaiting_provider_reply", "acknowledged"].includes(currentRoute?.status ?? "")) return;
			if (currentRun?.executionStatus === "failed" && currentRoute?.status === "delivery_failed") return;
			const message = "SMTP accepted the abuse report, but its durable delivery settlement could not be verified.";
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "email_delivery_settlement_conflict" });
			throw new UnknownExternalStateError(message);
		}
	} else if (result.status === "unknown_external_state") {
		const message = `SMTP delivery may have crossed the provider boundary: ${result.error ?? "transport response was lost"}`;
		await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "smtp_delivery_ambiguous" });
		throw new UnknownExternalStateError(message);
	} else {
		const settled = await AbuseRepository.settleEmailDelivery({
			runId: run.id,
			expectedRunStatus: "starting",
			expectedRouteStatus: "running",
			outcome: "failed",
			failureReason: result.error,
		});
		if (!settled) {
			const [currentRun, currentRoute] = await Promise.all([
				AbuseRepository.getProviderRun(run.id),
				AbuseRepository.getRoute(route.id),
			]);
			if (currentRun?.executionStatus === "failed" && currentRoute?.status === "delivery_failed") return;
			const message = "SMTP rejected the abuse report, but its durable failure settlement could not be verified.";
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "email_delivery_settlement_conflict" });
			throw new UnknownExternalStateError(message);
		}
		throw new RetryableDeliveryError(result.error ?? "SMTP delivery was rejected before provider acceptance.");
	}
}
