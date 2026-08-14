import { gnameServiceIdentity } from "../../registry";
import { AbuseRepository } from "../../repository";
import { envInt } from "../shared";

const GNAME_CODE_LOCK_PREFIX = "abuse:gname:shared-mailbox:";

export function gnameCodeLockKey(mailbox: string): string {
	return `${GNAME_CODE_LOCK_PREFIX}${mailbox.toLowerCase()}`;
}

export function gnameCodeLockOwner(routeId: bigint): string {
	return `abuse:gname:route:${routeId.toString()}`;
}

/**
 * An unknown GNAME task must continue to reserve the shared mailbox even
 * after its ordinary lease expires. The route-level blocker prevents a
 * second task from starting; this renewal also keeps the physical lock alive
 * across worker restarts while operations reconcile the external task.
 */
export async function maintainUnknownGnameLocks(): Promise<void> {
	const identity = gnameServiceIdentity();
	if (!identity.mailbox) return;
	const leaseMs = envInt("ABUSE_GNAME_CODE_LOCK_MS", 75 * 60_000);
	const routes = await AbuseRepository.listActiveGnameRoutes();
	for (const route of routes) {
		if (route.status !== "unknown_external_state") continue;
		await AbuseRepository.acquireOrRenewGnameMailboxLock({
			routeId: route.id,
			lockKey: gnameCodeLockKey(identity.mailbox),
			owner: gnameCodeLockOwner(route.id),
			leaseMs,
		});
	}
}
