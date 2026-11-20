import { eq } from "drizzle-orm";

import { getDb } from "../../../db";
import { providerLoginSessions } from "../../schema";

export type LoginSessionFailure = { message: string; until: number };

/** A stored record: the session's JSON (validated by its provider before use) and the last login failure. */
export type LoginSessionRecord = { session?: unknown; failure?: LoginSessionFailure };

/** Persistence seam so tests can swap the SQLite-backed default. */
export type LoginSessionStore = {
	read(key: string): Promise<LoginSessionRecord>;
	writeSession(key: string, session: unknown, expiresAt: number): Promise<void>;
	writeFailure(key: string, failure: LoginSessionFailure): Promise<void>;
	clear(key: string): Promise<void>;
};

export const sqliteLoginSessionStore: LoginSessionStore = {
	async read(key) {
		const db = await getDb();
		const row = db.select().from(providerLoginSessions).where(eq(providerLoginSessions.sessionKey, key)).get();
		if (!row) return {};
		return {
			...(row.session !== null ? { session: row.session } : {}),
			...(row.failureMessage && row.failureUntil !== null ? { failure: { message: row.failureMessage, until: row.failureUntil } } : {}),
		};
	},
	async writeSession(key, session, expiresAt) {
		const db = await getDb();
		const values = { session: session as Record<string, unknown>, expiresAt, failureMessage: null, failureUntil: null, updatedAt: Date.now() };
		db.insert(providerLoginSessions).values({ sessionKey: key, ...values })
			.onConflictDoUpdate({ target: providerLoginSessions.sessionKey, set: values }).run();
	},
	async writeFailure(key, failure) {
		const db = await getDb();
		const values = { failureMessage: failure.message, failureUntil: failure.until, updatedAt: Date.now() };
		db.insert(providerLoginSessions).values({ sessionKey: key, ...values })
			.onConflictDoUpdate({ target: providerLoginSessions.sessionKey, set: values }).run();
	},
	async clear(key) {
		const db = await getDb();
		db.delete(providerLoginSessions).where(eq(providerLoginSessions.sessionKey, key)).run();
	},
};

/** In-memory store for tests. */
export function createMemoryLoginSessionStore(): LoginSessionStore & { records: Map<string, LoginSessionRecord> } {
	const records = new Map<string, LoginSessionRecord>();
	return {
		records,
		async read(key) { return structuredClone(records.get(key) ?? {}); },
		async writeSession(key, session) { records.set(key, { session: structuredClone(session) }); },
		async writeFailure(key, failure) { records.set(key, { ...records.get(key), failure: { ...failure } }); },
		async clear(key) { records.delete(key); },
	};
}
