import { and, desc, gte, like } from "drizzle-orm";

import { getDb } from "../../db";
import { sha256Hex } from "../../util/hash";
import { abuseReports } from "../schema";
import type { FunnelParty } from "./extract";

/**
 * One funnel report per business and affiliate within this window, across
 * cases: a lure campaign hands out many links that end at the same
 * affiliate, and the business needs to hear about it once. A later case is
 * linked to the open report; after the window a recurring affiliate is
 * reported again.
 */
export const FUNNEL_REPORT_WINDOW_DAYS = 90;

/**
 * The key of a business and the affiliate it would terminate: its own ID
 * for the affiliate, or for a merchant without one, the network and the ID
 * that network credits. Report idempotency keys are `<key>:<submission id>`.
 */
export function funnelDedupeKey(party: Pick<FunnelParty, "role" | "site" | "affiliateIds" | "creditedBy">): string {
	const affiliate = party.affiliateIds[0] ?? (party.creditedBy ? `via ${party.creditedBy.site} ${party.creditedBy.id}` : "");
	return `funnel:${sha256Hex(`${party.role}\u0000${party.site}\u0000${affiliate}`).slice(0, 32)}`;
}

/** The newest funnel report of this business and affiliate created since `since`, from any case. */
export async function findRecentFunnelReport(dedupeKey: string, since: Date): Promise<{ id: bigint; submissionId: bigint | null } | undefined> {
	const db = await getDb();
	const [found] = await db
		.select({ id: abuseReports.id, submissionId: abuseReports.submissionId })
		.from(abuseReports)
		.where(and(like(abuseReports.idempotencyKey, `${dedupeKey}:%`), gte(abuseReports.createdAt, since)))
		.orderBy(desc(abuseReports.createdAt))
		.limit(1)
		.all();
	return found;
}
