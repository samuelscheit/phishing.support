import { releaseLock, renewLock } from "../../persistence/locks";
import { getProviderRun } from "../../persistence/provider_runs";
import { getRoute } from "../../persistence/reports";
import { reconcileSkyvernRun } from "../../worker/reconcile";
import { UnknownExternalStateError } from "../../worker/shared";
import type { ProviderReconciliationServices } from "../contracts";

import { gnamePositiveInt } from "./config";
import { GNAME_PROVIDER } from "./definition";
import { gnameRouteIdentity } from "./identity";
import { gnameCodeLockKey, gnameCodeLockOwner } from "./mailbox";
import { validateGnameSkyvernOutput } from "./output";

/**
 * GNAME owns the shared-mailbox lease around an externally active Skyvern
 * task. Reconciliation may renew the deterministic route owner, but never
 * re-acquire a lost lease: another route could otherwise consume its code.
 */
export async function reconcileGnamePortalRun(
	runId: bigint,
	worker: ProviderReconciliationServices,
): Promise<void> {
	const run = await getProviderRun(runId);
	if (!run || !run.skyvernRunId) return;
	const route = await getRoute(run.routeId);
	if (!route || route.providerRegistryKey !== GNAME_PROVIDER.key) return;
	const identity = gnameRouteIdentity(route);
	if (!identity) {
		const message = "The durable shared-mailbox identity is missing while the GNAME portal task remains active.";
		await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_mailbox_identity_missing" });
		throw new UnknownExternalStateError(message);
	}

	const lockKey = gnameCodeLockKey(identity.mailbox);
	const lockOwner = gnameCodeLockOwner(route.id);
	const leaseMs = gnamePositiveInt("ABUSE_GNAME_CODE_LOCK_MS", 75 * 60_000);
	if (!(await renewLock(lockKey, lockOwner, leaseMs))) {
		const message = "The shared GNAME mailbox lock was lost while the external run was active; automatic reconciliation is blocked.";
		await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_mailbox_lock_lost" });
		throw new UnknownExternalStateError(message);
	}
	const heartbeat = setInterval(() => {
		void renewLock(lockKey, lockOwner, leaseMs);
	}, Math.max(1_000, Math.floor(leaseMs / 3)));
	try {
		await reconcileSkyvernRun(runId, worker, ({ output, providerPayload }) =>
			validateGnameSkyvernOutput({ output, providerPayload }),
		);
	} finally {
		clearInterval(heartbeat);
		const finalRun = await getProviderRun(run.id);
		if (finalRun && ["completed", "failed", "canceled"].includes(finalRun.executionStatus)) {
			await releaseLock(lockKey, lockOwner);
		}
	}
}
