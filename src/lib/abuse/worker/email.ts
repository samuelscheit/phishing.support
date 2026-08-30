import {
	abuseEmailCaseUrl,
	createAbuseEmailDraft,
	isSafeEmailDeliveryFailure,
	readVerifiedEmailDraft,
	sendAbuseEmailRoute,
	type AbuseEmailDraft,
	verifiedEmailProviderPayload,
} from "../mail";
import { isGenericEmailRouteEnabled } from "../providers/email";
import { AbuseRepository } from "../repository";
import { errorText, RetryableDeliveryError, routeContext, UnknownExternalStateError, type WorkerServices } from "./shared";

type EmailWorkerServices = Pick<WorkerServices, "markUnknownExternal"> & {
	/** Injectable for deterministic worker tests; production uses the canonical draft builder. */
	createDraft?: typeof createAbuseEmailDraft;
	/** Injectable for deterministic worker tests; production uses the canonical SMTP boundary. */
	send?: typeof sendAbuseEmailRoute;
};

export async function sendEmail(routeId: bigint, worker: EmailWorkerServices): Promise<void> {
	const { route, report, target, evidenceArtifacts } = await routeContext(routeId);
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
	if (!isGenericEmailRouteEnabled()) {
		await AbuseRepository.transitionRouteStatus({
			routeId: route.id,
			from: ["verified", "delivery_failed"],
			to: "no_route",
			data: { reason: "generic_email_route_disabled" },
		});
		return;
	}
	const correlationKey = `email-run:${route.id.toString()}`;
	const caseUrl = abuseEmailCaseUrl(report.idempotencyKey);
	const allowedDraftUrls = [
		...target.observedUrls,
		...(report.legalBrandUrl ? [report.legalBrandUrl] : []),
		...(caseUrl ? [caseUrl] : []),
	];
	const attachments = evidenceArtifacts.slice(0, 15).map((artifact) => ({ filename: artifact.name, mimeType: artifact.mimeType, content: artifact.blob }));
	let draft: AbuseEmailDraft | undefined;
	let providerPayload: Record<string, unknown>;
	if (route.status === "delivery_failed") {
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
		});
		providerPayload = verifiedEmailProviderPayload({
			target: target.normalizedTarget,
			observedUrls: target.observedUrls,
			recipient: route.verifiedEmail,
			email: draft,
		});
	}
	const delivery = await AbuseRepository.beginEmailDelivery({
		routeId: route.id,
		correlationKey,
		providerPayload,
	});
	if (!delivery) return;
	const run = delivery.run;
	// A delivery retry uses the immutable first-attempt draft, including its
	// model-produced summary. Never regenerate recipient-facing prose after a
	// durable report attempt has begun.
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
			attachments,
			correlationKey,
			replyAddress: retryReplyAddress,
		});
	} catch (error) {
		// MIME construction, local artifact persistence, and outbound-message
		// persistence all happen before SMTP. Those failures are therefore
		// safely retryable, but only after the claimed route/run are atomically
		// returned to the known delivery-failed state. Do not let a normal job
		// retry strand this route in `running`.
		const failure = errorText(error);
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
			await AbuseRepository.enqueueJob({ jobType: "monitor_provider_reply", reportId: report.id, routeId: route.id, runId: run.id, payload: {}, dedupeKey: `monitor:${run.id.toString()}`, nextAttemptAt: new Date(Date.now() + 24 * 60 * 60_000) });
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
