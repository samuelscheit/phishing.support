import { and, desc, gte, like, ne, notInArray } from "drizzle-orm";

import { getDb } from "../../db";
import { sha256Hex } from "../../util/hash";
import { sleep } from "../../util/sleep";
import { AbuseRepository } from "../repository";
import { abuseReports, type AbuseReportStatus } from "../schema";
import type { FunnelParty } from "./extract";

/**
 * One funnel report per business and affiliate within this window, across
 * cases: a lure campaign hands out many links that end at the same
 * affiliate, and the business needs to hear about it once. A later case is
 * linked to the open report; after the window a recurring affiliate is
 * reported again.
 */
export const FUNNEL_REPORT_WINDOW_DAYS = 90;

/** Reports that reached nobody: a later case reports the affiliate anew instead of being silenced by them. */
const UNDELIVERED: readonly AbuseReportStatus[] = ["no_route", "failed", "insufficient_evidence", "canceled"];

const LOCK_LEASE_MS = 30_000;
const LOCK_ATTEMPTS = 50;
const LOCK_RETRY_MS = 100;

/**
 * The key of a business and the affiliate it would terminate: its own ID
 * for the affiliate, or for a merchant without one, the network and the ID
 * that network credits. Report idempotency keys are `<key>:<submission id>`.
 */
export function funnelDedupeKey(party: Pick<FunnelParty, "role" | "site" | "affiliateIds" | "creditedBy">): string {
	const affiliate = party.affiliateIds[0] ?? (party.creditedBy ? `via ${party.creditedBy.site} ${party.creditedBy.id}` : "");
	return `funnel:${sha256Hex(`${party.role}\u0000${party.site}\u0000${affiliate}`).slice(0, 32)}`;
}

/**
 * The newest report of this business and affiliate from another case,
 * created since `since`, that was delivered or is still on its way.
 */
export async function findOpenFunnelReport(dedupeKey: string, ownIdempotencyKey: string, since: Date): Promise<{ id: bigint; submissionId: bigint | null } | undefined> {
	const db = await getDb();
	const [found] = await db
		.select({ id: abuseReports.id, submissionId: abuseReports.submissionId })
		.from(abuseReports)
		.where(and(
			like(abuseReports.idempotencyKey, `${dedupeKey}:%`),
			ne(abuseReports.idempotencyKey, ownIdempotencyKey),
			gte(abuseReports.createdAt, since),
			notInArray(abuseReports.status, [...UNDELIVERED]),
		))
		.orderBy(desc(abuseReports.createdAt))
		.limit(1)
		.all();
	return found;
}

/**
 * Runs `work` while holding the lock of this business and affiliate, so
 * that two cases finishing at once cannot both find no report and both
 * create one. Throws when the lock stays taken, so the caller retries.
 */
export async function withFunnelReportLock<T>(dedupeKey: string, owner: string, work: () => Promise<T>): Promise<T> {
	const lockKey = `funnel-report:${dedupeKey}`;
	for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
		if (await AbuseRepository.tryAcquireLock(lockKey, owner, LOCK_LEASE_MS)) {
			try {
				return await work();
			} finally {
				await AbuseRepository.releaseLock(lockKey, owner);
			}
		}
		await sleep(LOCK_RETRY_MS);
	}
	throw new Error(`The funnel report lock ${lockKey} stayed taken; report the case again later.`);
}
