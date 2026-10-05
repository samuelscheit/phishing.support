import { and, asc, eq, inArray, ne } from "drizzle-orm";

import { getDb } from "../../../../db";
import { abuseLocks, abuseProviderRoutes, type AbuseProviderRoute } from "../../../schema";
import { now } from "../../../persistence/shared";

type MailboxLeaseParams = {
	routeId: bigint;
	lockKey: string;
	owner: string;
	leaseMs: number;
};

type MailboxLeaseResult =
	| { acquired: true; route: AbuseProviderRoute }
	| { acquired: false; reason: "route_missing" | "active_route" | "lock_owned" };

/**
 * Claim or extend GNAME's one shared verification-mailbox lease inside a
 * caller-owned transaction. The durable active-route check is inseparable
 * from the physical lock: a lease may expire while the external portal still
 * owns the next code, and an unknown external state must continue blocking a
 * different GNAME route.
 */
export function acquireMailboxLeaseInTransaction(tx: any, params: MailboxLeaseParams): MailboxLeaseResult {
	const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, params.routeId)).get();
	if (!route || route.providerRegistryKey !== "gname") return { acquired: false, reason: "route_missing" };

	const activeOtherRoute = tx
		.select({ id: abuseProviderRoutes.id })
		.from(abuseProviderRoutes)
		.where(
			and(
				eq(abuseProviderRoutes.providerRegistryKey, "gname"),
				ne(abuseProviderRoutes.id, route.id),
				inArray(abuseProviderRoutes.status, ["running", "waiting_code", "unknown_external_state"]),
			),
		)
		.limit(1)
		.get();
	if (activeOtherRoute) return { acquired: false, reason: "active_route" };

	const timestamp = now();
	const existing = tx.select().from(abuseLocks).where(eq(abuseLocks.lockKey, params.lockKey)).get();
	if (existing && existing.leaseExpiresAt > timestamp && existing.owner !== params.owner) {
		return { acquired: false, reason: "lock_owned" };
	}
	const leaseExpiresAt = new Date(timestamp.getTime() + params.leaseMs);
	if (existing) {
		tx.update(abuseLocks)
			.set({ owner: params.owner, leaseExpiresAt, updatedAt: timestamp })
			.where(eq(abuseLocks.lockKey, params.lockKey))
			.run();
	} else {
		tx.insert(abuseLocks).values({ lockKey: params.lockKey, owner: params.owner, leaseExpiresAt, updatedAt: timestamp }).run();
	}
	return { acquired: true, route };
}

/**
 * Atomically owns or renews GNAME's shared verification mailbox. This is
 * used after a task is already waiting for mail and by the maintenance loop;
 * portal creation uses the same transaction helper together with run setup.
 */
export async function acquireOrRenewMailboxLease(params: MailboxLeaseParams): Promise<{
	acquired: boolean;
	reason?: "route_missing" | "active_route" | "lock_owned";
}> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const result = acquireMailboxLeaseInTransaction(tx, params);
			if (!result.acquired) return { acquired: false, reason: result.reason };
			return { acquired: true };
		},
		{ behavior: "immediate" },
	);
}

/** List every GNAME route whose durable state still reserves the mailbox. */
export async function listActiveMailboxRoutes(): Promise<AbuseProviderRoute[]> {
	const db = await getDb();
	return db
		.select()
		.from(abuseProviderRoutes)
		.where(and(eq(abuseProviderRoutes.providerRegistryKey, "gname"), inArray(abuseProviderRoutes.status, ["running", "waiting_code", "unknown_external_state"])))
		.orderBy(asc(abuseProviderRoutes.updatedAt))
		.all();
}

/**
 * The shared mailbox can only be correlated safely when exactly one durable
 * GNAME route is waiting for a verification code.
 */
export async function getSoleWaitingCodeRoute(): Promise<AbuseProviderRoute | undefined> {
	const db = await getDb();
	const routes = await db
		.select()
		.from(abuseProviderRoutes)
		.where(and(eq(abuseProviderRoutes.providerRegistryKey, "gname"), eq(abuseProviderRoutes.status, "waiting_code")))
		.orderBy(asc(abuseProviderRoutes.updatedAt))
		.limit(2);
	return routes.length === 1 ? routes[0] : undefined;
}
