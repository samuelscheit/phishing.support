import { and, eq } from "drizzle-orm";

import { getDb } from "../../db";
import { abuseLocks } from "../schema";
import { now } from "./shared";

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
