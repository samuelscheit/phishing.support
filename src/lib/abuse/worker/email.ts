import { sendAbuseEmailRoute, isSafeEmailDeliveryFailure } from "../mail";
import { isGenericEmailRouteEnabled } from "../providers/email";
import { AbuseRepository } from "../repository";
import { errorText, RetryableDeliveryError, routeContext, UnknownExternalStateError, type WorkerServices } from "./shared";

export async function sendEmail(routeId: bigint, worker: Pick<WorkerServices, "markUnknownExternal">): Promise<void> {
	const { route, report, target, evidenceArtifacts } = await routeContext(routeId);
	if (route.routeType !== "email" || !route.verifiedEmail) return;
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
	const delivery = await AbuseRepository.beginEmailDelivery({
		routeId: route.id,
		correlationKey,
		providerPayload: {
			kind: "verified_email_report",
			target: target.normalizedTarget,
			description: report.description,
			observedUrls: target.observedUrls,
			recipient: route.verifiedEmail,
		},
	});
	if (!delivery) return;
	const run = delivery.run;
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
	const attachments = evidenceArtifacts.slice(0, 15).map((artifact) => ({ filename: artifact.name, mimeType: artifact.mimeType, content: artifact.blob }));
	let result: Awaited<ReturnType<typeof sendAbuseEmailRoute>>;
	try {
		result = await sendAbuseEmailRoute({
			routeId: route.id,
			runId: run.id,
			reportId: report.id,
			recipient: route.verifiedEmail,
			subject: `[Phishing Support] Abuse report for ${target.normalizedTarget}`,
			body: `Target: ${target.normalizedTarget}\nObserved URLs: ${target.observedUrls.join("\n")}\n\n${report.description}`,
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
		if (await AbuseRepository.settleEmailDelivery({
			runId: run.id,
			expectedRunStatus: "starting",
			expectedRouteStatus: "running",
			outcome: "sent",
		})) {
			await AbuseRepository.enqueueJob({ jobType: "monitor_provider_reply", reportId: report.id, routeId: route.id, runId: run.id, payload: {}, dedupeKey: `monitor:${run.id.toString()}`, nextAttemptAt: new Date(Date.now() + 24 * 60 * 60_000) });
		}
	} else if (result.status === "unknown_external_state") {
		const message = `SMTP delivery may have crossed the provider boundary: ${result.error ?? "transport response was lost"}`;
		await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "smtp_delivery_ambiguous" });
		throw new UnknownExternalStateError(message);
	} else {
		await AbuseRepository.settleEmailDelivery({
			runId: run.id,
			expectedRunStatus: "starting",
			expectedRouteStatus: "running",
			outcome: "failed",
			failureReason: result.error,
		});
		throw new RetryableDeliveryError(result.error ?? "SMTP delivery was rejected before provider acceptance.");
	}
}
