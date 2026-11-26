import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";

import { getDb } from "../db";
import { registrableDomain } from "../abuse/security/security";
import type { FetchFailure, IconSource } from "./extract";
import { favicons, type Favicon } from "./schema";

/** A provider website's icon as our origin serves it; the version makes the URL immutable. */
export const faviconPath = (domain: string, version: string) => `/api/favicons/${encodeURIComponent(domain)}?v=${version}`;

/** A domain an icon is kept for: a registrable domain in lower case, nothing else (no host, IP or path). */
export function isFaviconDomain(value: string): boolean {
	return value === value.toLowerCase() && registrableDomain(value) === value;
}

/**
 * Shared by every copy of this module: Next bundles its route handlers apart
 * from the server that runs the refresh, so a module-level set would not
 * reach it.
 */
const newDomainListeners: Set<() => void> = ((globalThis as { [key: symbol]: unknown })[Symbol.for("phishing-reporter.favicon-listeners")] ??= new Set()) as Set<() => void>;

/** Called whenever a page names a domain no icon was asked for yet. */
export function onNewFaviconDomains(listener: () => void): () => void {
	newDomainListeners.add(listener);
	return () => newDomainListeners.delete(listener);
}

export class FaviconStore {
	/**
	 * The served icon of each domain that has one. A domain never asked for
	 * is recorded as pending, due at once, for the background refresh; the
	 * page shows initials until then and never waits for a fetch.
	 */
	static async iconsFor(domains: Iterable<string>, now = new Date()): Promise<Map<string, string>> {
		const wanted = [...new Set(domains)].filter(isFaviconDomain);
		if (wanted.length === 0) return new Map();
		const db = await getDb();
		const rows = db.select({ domain: favicons.domain, status: favicons.status, version: favicons.version }).from(favicons).where(inArray(favicons.domain, wanted)).all();
		const known = new Set(rows.map((row) => row.domain));
		const unknown = wanted.filter((domain) => !known.has(domain));
		if (unknown.length > 0) {
			db.insert(favicons).values(unknown.map((domain) => ({ domain, status: "pending" as const, checkAt: now, createdAt: now }))).onConflictDoNothing().run();
			for (const listener of newDomainListeners) listener();
		}
		return new Map(rows.flatMap((row) => (row.status === "found" && row.version ? [[row.domain, faviconPath(row.domain, row.version)] as const] : [])));
	}

	/** Lease the domain due first, so no other refresher takes it until `leaseMs` passed. */
	static async claimDue(now: Date, leaseMs: number): Promise<Favicon | undefined> {
		const db = await getDb();
		return db.transaction((tx) => {
			const due = tx.select().from(favicons)
				.where(and(lte(favicons.checkAt, now), or(isNull(favicons.claimedUntil), lte(favicons.claimedUntil, now))))
				.orderBy(asc(favicons.checkAt))
				.limit(1)
				.get();
			if (!due) return undefined;
			const claimedUntil = new Date(now.getTime() + leaseMs);
			tx.update(favicons).set({ claimedUntil }).where(eq(favicons.domain, due.domain)).run();
			return { ...due, claimedUntil };
		}, { behavior: "immediate" });
	}

	static async recordFound(domain: string, png: Buffer, source: IconSource, now: Date, checkAt: Date): Promise<void> {
		const version = createHash("sha256").update(png).digest("hex").slice(0, 16);
		await FaviconStore.update(domain, { status: "found", png, version, source, failure: null, reason: null, fetchedAt: now, checkAt });
	}

	/** No icon: what was stored is dropped, and the domain is asked again at `checkAt`. */
	static async recordMissing(domain: string, failure: FetchFailure, reason: string, now: Date, checkAt: Date): Promise<void> {
		await FaviconStore.update(domain, { status: "missing", png: null, version: null, source: null, failure, reason, fetchedAt: now, checkAt });
	}

	/** The stored icon stays as it is until `checkAt`; `reason` says why it was not confirmed, when it was not. */
	static async recordKept(domain: string, checkAt: Date, reason: string | null): Promise<void> {
		await FaviconStore.update(domain, { reason, checkAt });
	}

	static async served(domain: string): Promise<Pick<Favicon, "png" | "version"> | undefined> {
		const db = await getDb();
		const row = db.select({ png: favicons.png, version: favicons.version }).from(favicons).where(and(eq(favicons.domain, domain), eq(favicons.status, "found"))).get();
		return row?.png && row.version ? row : undefined;
	}

	static async get(domain: string): Promise<Favicon | undefined> {
		const db = await getDb();
		return db.select().from(favicons).where(eq(favicons.domain, domain)).get();
	}

	private static async update(domain: string, values: Partial<Favicon>): Promise<void> {
		const db = await getDb();
		db.update(favicons).set({ ...values, claimedUntil: null }).where(eq(favicons.domain, domain)).run();
	}
}
