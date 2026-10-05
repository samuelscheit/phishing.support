import { gnamePositiveInt } from "./config";
import { gnameRouteIdentity } from "./identity";
import { acquireOrRenewMailboxLease, listActiveMailboxRoutes } from "./persistence/mailbox";

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
export async function maintainGnameMailboxReservations(): Promise<void> {
	const leaseMs = gnamePositiveInt("ABUSE_GNAME_CODE_LOCK_MS", 75 * 60_000);
	const routes = await listActiveMailboxRoutes();
	for (const route of routes) {
		if (route.status !== "unknown_external_state") continue;
		const identity = gnameRouteIdentity(route);
		if (!identity) continue;
		await acquireOrRenewMailboxLease({
			routeId: route.id,
			lockKey: gnameCodeLockKey(identity.mailbox),
			owner: gnameCodeLockOwner(route.id),
			leaseMs,
		});
	}
}
