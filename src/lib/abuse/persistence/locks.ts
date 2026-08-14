import { and, eq, inArray, ne } from "drizzle-orm";

import { getDb } from "../../db";
import { abuseLocks, abuseProviderRoutes } from "../schema";
import { now, recordEvent } from "./shared";

export async function tryAcquireLock(lockKey: string, owner: string, leaseMs: number): Promise<boolean> {
	const db = await getDb();
	const timestamp = now();
	const expires = new Date(timestamp.getTime() + leaseMs);
	return db.transaction(
		(tx) => {
			const existing = tx.select().from(abuseLocks).where(eq(abuseLocks.lockKey, lockKey)).get();
			if (existing && existing.leaseExpiresAt > timestamp && existing.owner !== owner) return false;
			if (existing) {
				tx.update(abuseLocks).set({ owner, leaseExpiresAt: expires, updatedAt: timestamp }).where(eq(abuseLocks.lockKey, lockKey)).run();
			} else {
				tx.insert(abuseLocks).values({ lockKey, owner, leaseExpiresAt: expires, updatedAt: timestamp }).run();
			}
			return true;
		},
		{ behavior: "immediate" }
	);
}

export async function releaseLock(lockKey: string, owner: string): Promise<void> {
	const db = await getDb();
	await db.delete(abuseLocks).where(and(eq(abuseLocks.lockKey, lockKey), eq(abuseLocks.owner, owner)));
}

/** Extends a lock only when this route still owns it. */

export async function renewLock(lockKey: string, owner: string, leaseMs: number): Promise<boolean> {
	const db = await getDb();
	const timestamp = now();
	const result = await db
		.update(abuseLocks)
		.set({ leaseExpiresAt: new Date(timestamp.getTime() + leaseMs), updatedAt: timestamp })
		.where(and(eq(abuseLocks.lockKey, lockKey), eq(abuseLocks.owner, owner)))
		.returning({ lockKey: abuseLocks.lockKey })
		.get();
	return Boolean(result);
}

/**
 * Atomically owns or renews the shared GNAME verification-mailbox lease.
 * The lock alone is not enough: a process outage can let a lease expire
 * while an external GNAME task is still waiting for mail.  Therefore the
 * durable active-route state is checked in the same transaction before a
 * different route can take the lease.  An `unknown_external_state` route
 * deliberately blocks later GNAME runs until operations resolve it.
 */

export async function acquireOrRenewGnameMailboxLock(params: {
	routeId: bigint;
	lockKey: string;
	owner: string;
	leaseMs: number;
	markRouteRunning?: boolean;
}): Promise<{ acquired: boolean; reason?: "route_missing" | "active_route" | "lock_owned" }> {
	const db = await getDb();
	const timestamp = now();
	const expiresAt = new Date(timestamp.getTime() + params.leaseMs);
	return db.transaction(
		(tx) => {
			const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, params.routeId)).get();
			if (!route) return { acquired: false, reason: "route_missing" as const };
			const activeOtherRoute = tx
				.select({ id: abuseProviderRoutes.id })
				.from(abuseProviderRoutes)
				.where(
					and(
						eq(abuseProviderRoutes.providerRegistryKey, "gname"),
						ne(abuseProviderRoutes.id, params.routeId),
						inArray(abuseProviderRoutes.status, ["running", "waiting_code", "unknown_external_state"]),
					),
				)
				.limit(1)
				.get();
			if (activeOtherRoute) return { acquired: false, reason: "active_route" as const };

			const existing = tx.select().from(abuseLocks).where(eq(abuseLocks.lockKey, params.lockKey)).get();
			if (existing && existing.leaseExpiresAt > timestamp && existing.owner !== params.owner) {
				return { acquired: false, reason: "lock_owned" as const };
			}
			if (existing) {
				tx.update(abuseLocks)
					.set({ owner: params.owner, leaseExpiresAt: expiresAt, updatedAt: timestamp })
					.where(eq(abuseLocks.lockKey, params.lockKey))
					.run();
			} else {
				tx.insert(abuseLocks).values({ lockKey: params.lockKey, owner: params.owner, leaseExpiresAt: expiresAt, updatedAt: timestamp }).run();
			}
			if (params.markRouteRunning && route.status !== "running") {
				tx.update(abuseProviderRoutes).set({ status: "running", updatedAt: timestamp }).where(eq(abuseProviderRoutes.id, route.id)).run();
				recordEvent(tx, {
					reportId: route.reportId,
					targetId: route.targetId,
					routeId: route.id,
					eventType: "route.status_changed",
					data: { from: route.status, to: "running", reason: "gname_mailbox_lock_acquired" },
				});
			}
			return { acquired: true };
		},
		{ behavior: "immediate" },
	);
}
