import { DAY_MS } from "../../util/date_time";
import { sha256Hex } from "../../util/hash";
import type { ReportSubject } from "../persistence/reports";
import type { FunnelParty } from "./extract";

/**
 * One funnel report per business and affiliate within this window, across
 * cases: a lure campaign hands out many links that end at the same
 * affiliate, and the business needs to hear about it once. A later case
 * joins the open report; after the window a recurring affiliate is reported
 * again.
 */
export const FUNNEL_REPORT_WINDOW_DAYS = 90;

/**
 * The report subject of a business and the affiliate it would terminate: its
 * own ID for the affiliate, or for a merchant without one, the network and
 * the ID that network credits. Report idempotency keys are
 * `<key>:<submission id>`.
 */
export function funnelReportSubject(party: Pick<FunnelParty, "role" | "site" | "affiliateIds" | "creditedBy">): Extract<ReportSubject, { key: string }> {
	const affiliate = party.affiliateIds[0] ?? (party.creditedBy ? `via ${party.creditedBy.site} ${party.creditedBy.id}` : "");
	return { key: `funnel:${sha256Hex(`${party.role}\u0000${party.site}\u0000${affiliate}`).slice(0, 32)}`, windowMs: FUNNEL_REPORT_WINDOW_DAYS * DAY_MS };
}
