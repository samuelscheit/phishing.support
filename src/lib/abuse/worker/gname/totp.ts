import { extractUnambiguousVerificationCode } from "../../mail";
import { gnameServiceIdentity } from "../../registry";
import { AbuseRepository } from "../../repository";
import type { AbuseJob } from "../../schema";
import {
	errorText,
	envInt,
	idFrom,
	parseJobBigInt,
	parseOptionalBigInt,
	UnknownExternalStateError,
	type WorkerServices,
} from "../shared";
import { gnameCodeLockKey, gnameCodeLockOwner } from "./mailbox";

/** Delivers a route-bound verification code through the reserved shared mailbox. */
export async function sendTotpCode(job: AbuseJob, worker: WorkerServices): Promise<void> {
	const routeId = idFrom(job.routeId, "routeId");
	const route = await AbuseRepository.getRoute(routeId);
	if (!route || route.providerRegistryKey !== "gname" || route.status !== "waiting_code") return;
	const messageId = parseJobBigInt(job.payload?.messageId, "payload.messageId");
	const mail = await AbuseRepository.getMailMessage(messageId);
	if (!mail || mail.routeId !== route.id) throw new Error("Verification-code message is not associated with the provider route.");
	const code = extractUnambiguousVerificationCode(mail.textBody ?? "");
	if (!code) throw new Error("No unambiguous verification code was found in the provider message.");
	const runId = job.runId ?? parseOptionalBigInt(job.payload?.runId);
	const run = runId ? await AbuseRepository.getProviderRun(runId) : await AbuseRepository.getLatestActiveProviderRunForRoute(route.id);
	if (!run?.skyvernRunId) {
		const message = "No active Skyvern run could be safely correlated with the GNAME verification code.";
		await worker.markUnknownExternal({ routeId: route.id, runId: run?.id, error: message, reason: "totp_without_active_run" });
		throw new UnknownExternalStateError(message);
	}
	if (run.executionStatus === "sending_code") {
		const message = "GNAME verification-code delivery was interrupted after its durable pre-delivery marker; automatic replay is unsafe.";
		await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "totp_delivery_interrupted" });
		throw new UnknownExternalStateError(message);
	}
	// Resolve local configuration only after the run is correlated. A missing
	// key/base URL is a retryable local failure and did not contact Skyvern.
	const adapter = worker.getAdapter();
	const identifier = typeof job.payload?.totpIdentifier === "string" && job.payload.totpIdentifier.trim()
		? job.payload.totpIdentifier.trim()
		: gnameServiceIdentity().mailbox;
	if (!identifier) throw new Error("GNAME TOTP identifier is not configured.");
	const lockKey = gnameCodeLockKey(identifier);
	const lockOwner = gnameCodeLockOwner(route.id);
	if (!(await AbuseRepository.acquireOrRenewGnameMailboxLock({
		routeId: route.id,
		lockKey,
		owner: lockOwner,
		leaseMs: envInt("ABUSE_GNAME_CODE_LOCK_MS", 75 * 60_000),
	})).acquired) {
		throw new Error("The shared GNAME verification mailbox is no longer reserved for this route.");
	}
	// Persist the correlation before the side-effectful SDK call. If its
	// response is lost, the code is permanently tied to this exact task and
	// will never be replayed by an automatic retry.
	const preparation = await AbuseRepository.prepareTotpDelivery({
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
		if (!(await AbuseRepository.settleTotpDelivery({ routeId: route.id, runId: run.id, mailCodeId: preparation.mailCodeId }))) {
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
