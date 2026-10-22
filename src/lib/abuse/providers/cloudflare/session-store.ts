import { eq } from "drizzle-orm";

import { getDb } from "../../../db";
import { cloudflareDashboardSessions } from "../../schema";

export type CloudflareSession = { atok: string; vses2: string; expiresAt: number };

export type CloudflareSessionFailure = { message: string; until: number };

export type CloudflareSessionRecord = { session?: CloudflareSession; failure?: CloudflareSessionFailure };

/** Persistence seam so tests and callers can swap the SQLite-backed default. */
export type CloudflareSessionStore = {
	read(key: string): Promise<CloudflareSessionRecord>;
	writeSession(key: string, session: CloudflareSession): Promise<void>;
	writeFailure(key: string, failure: CloudflareSessionFailure): Promise<void>;
	clear(key: string): Promise<void>;
};

export const sqliteCloudflareSessionStore: CloudflareSessionStore = {
	async read(key) {
		const db = await getDb();
		const row = db.select().from(cloudflareDashboardSessions).where(eq(cloudflareDashboardSessions.sessionKey, key)).get();
		if (!row) return {};
		return {
			session: row.atok && row.vses2 && row.expiresAt !== null ? { atok: row.atok, vses2: row.vses2, expiresAt: row.expiresAt } : undefined,
			failure: row.failureMessage && row.failureUntil !== null ? { message: row.failureMessage, until: row.failureUntil } : undefined,
		};
	},
	async writeSession(key, session) {
		const db = await getDb();
		const values = { atok: session.atok, vses2: session.vses2, expiresAt: session.expiresAt, failureMessage: null, failureUntil: null, updatedAt: Date.now() };
		db.insert(cloudflareDashboardSessions).values({ sessionKey: key, ...values })
			.onConflictDoUpdate({ target: cloudflareDashboardSessions.sessionKey, set: values }).run();
	},
	async writeFailure(key, failure) {
		const db = await getDb();
		const values = { failureMessage: failure.message, failureUntil: failure.until, updatedAt: Date.now() };
		db.insert(cloudflareDashboardSessions).values({ sessionKey: key, ...values })
			.onConflictDoUpdate({ target: cloudflareDashboardSessions.sessionKey, set: values }).run();
	},
	async clear(key) {
		const db = await getDb();
		db.delete(cloudflareDashboardSessions).where(eq(cloudflareDashboardSessions.sessionKey, key)).run();
	},
};

/** In-memory store for tests. */
export function createMemoryCloudflareSessionStore(): CloudflareSessionStore & { records: Map<string, CloudflareSessionRecord> } {
	const records = new Map<string, CloudflareSessionRecord>();
	return {
		records,
		async read(key) { return structuredClone(records.get(key) ?? {}); },
		async writeSession(key, session) { records.set(key, { session: { ...session } }); },
		async writeFailure(key, failure) { records.set(key, { ...records.get(key), failure: { ...failure } }); },
		async clear(key) { records.delete(key); },
	};
}
