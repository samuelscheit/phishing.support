import { getMailMessage } from "../../persistence/mail";
import { getProviderRun } from "../../persistence/provider_runs";
import { getRoute } from "../../persistence/reports";
import {
	errorText,
	parseJobBigInt,
	UnknownExternalStateError,
	type WorkerServices,
} from "../../worker/shared";
import { gnamePositiveInt } from "./config";
import { activeGnameRouteIdentity } from "./identity";
import { gnameVerificationCodeFromMessage, storedGnameSenderAddresses } from "./inbound_policy";
import { gnameCodeLockKey, gnameCodeLockOwner } from "./mailbox";
import { prepareVerificationCodeDelivery, settleVerificationCodeDelivery } from "./persistence/code_delivery";
import { acquireOrRenewMailboxLease } from "./persistence/mailbox";
import { getLatestGnameActiveRunForRoute } from "./persistence/runs";

/** Fence an active GNAME task when a code-delivery job exhausts local retries. */
export async function fenceGnameRetryExhaustion(
	params: { routeId: bigint; runId?: bigint; jobType: string; error: string },
	worker: Pick<WorkerServices, "markUnknownExternal">,
): Promise<boolean> {
	if (params.jobType !== "deliver_provider_verification_code") return false;
	const candidate = params.runId ? await getProviderRun(params.runId) : await getLatestGnameActiveRunForRoute(params.routeId);
	const run = candidate && candidate.routeId === params.routeId ? candidate : undefined;
	if (!run?.skyvernRunId) return false;
	await worker.markUnknownExternal({
		routeId: params.routeId,
		runId: run.id,
		error: `Verification-code retries were exhausted while a GNAME task remained externally active: ${params.error}`,
		reason: "skyvern_reconciliation_retry_exhausted",
	});
	return true;
}

/** Delivers a route-bound verification code through the reserved shared mailbox. */
export async function deliverGnameVerificationCode(params: {
	routeId: bigint;
	runId?: bigint;
	payload: Record<string, unknown>;
}, worker: WorkerServices): Promise<void> {
	const route = await getRoute(params.routeId);
	if (!route || route.providerRegistryKey !== "gname" || route.status !== "waiting_code") return;
	const messageId = parseJobBigInt(params.payload.messageId, "payload.messageId");
	const mail = await getMailMessage(messageId);
	const identity = activeGnameRouteIdentity(route);
	if (!identity) {
		const message = "The configured GNAME service identity no longer matches the durable route mailbox.";
		await worker.markUnknownExternal({ routeId: route.id, error: message, reason: "gname_service_identity_drift" });
		throw new UnknownExternalStateError(message);
	}
	const code = mail && mail.reportId === route.reportId && mail.routeId === route.id && mail.direction === "inbound"
		? gnameVerificationCodeFromMessage({
			senderAddresses: storedGnameSenderAddresses(mail.fromAddress),
			recipients: mail.toAddresses,
			textBody: mail.textBody ?? "",
			mailbox: identity.mailbox,
		})
		: undefined;
	if (!mail || !code) throw new Error("Verification-code message does not satisfy the durable GNAME inbound-mail policy.");
	const candidateRun = params.runId ? await getProviderRun(params.runId) : undefined;
	const run = candidateRun && candidateRun.routeId === route.id && candidateRun.reportId === route.reportId ? candidateRun : undefined;
	if (run?.executionStatus === "sending_code") {
		const message = "GNAME verification-code delivery was interrupted after its durable pre-delivery marker; automatic replay is unsafe.";
		await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "totp_delivery_interrupted" });
		throw new UnknownExternalStateError(message);
	}
	if (!run?.skyvernRunId || run.executionStatus !== "waiting_code") {
		const message = "No active Skyvern run could be safely correlated with the GNAME verification code.";
		await worker.markUnknownExternal({ routeId: route.id, runId: run?.id, error: message, reason: "totp_without_active_run" });
		throw new UnknownExternalStateError(message);
	}
	// Resolve local configuration only after the run is correlated. A missing
	// key/base URL is a retryable local failure and did not contact Skyvern.
	const adapter = worker.getAdapter();
	const identifier = identity.mailbox;
	const lockKey = gnameCodeLockKey(identifier);
	const lockOwner = gnameCodeLockOwner(route.id);
	if (!(await acquireOrRenewMailboxLease({
		routeId: route.id,
		lockKey,
		owner: lockOwner,
		leaseMs: gnamePositiveInt("ABUSE_GNAME_CODE_LOCK_MS", 75 * 60_000),
	})).acquired) {
		throw new Error("The shared GNAME verification mailbox is no longer reserved for this route.");
	}
	// Persist the correlation before the side-effectful SDK call. If its
	// response is lost, the code is permanently tied to this exact task and
	// will never be replayed by an automatic retry.
	const preparation = await prepareVerificationCodeDelivery({
		routeId: route.id,
		runId: run.id,
		mailMessageId: mail.id,
		code,
		correlationKey: run.correlationKey,
	});
	if (preparation.state === "already_started") {
		const message = "GNAME verification-code delivery already entered an ambiguous external state.";
		await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "totp_delivery_interrupted" });
		throw new UnknownExternalStateError(message);
	}
	try {
		await adapter.sendTotpCode({ identifier, content: code, taskId: run.skyvernRunId });
		if (!(await settleVerificationCodeDelivery({ routeId: route.id, runId: run.id, mailCodeId: preparation.mailCodeId }))) {
			const message = "Verification code delivery completed after the route left its expected state; operational reconciliation is required.";
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "totp_delivery_state_changed" });
			throw new UnknownExternalStateError(message);
		}
	} catch (error) {
		// Preserve the shared-mailbox lease after an ambiguous SDK delivery. It
		// remains owned until explicit operational resolution. Repeating an OTP
		// request could race the same portal task or consume a later code.
		const message = `Skyvern verification-code delivery was ambiguous: ${errorText(error)}`;
		await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "totp_delivery_ambiguous" });
		throw new UnknownExternalStateError(message);
	}
}
