import { InferSelectModel, sql } from "drizzle-orm";
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { abuseReports, abuseTargets } from "../abuse/schema";
import { sqliteBigint, sqliteInteger, sqliteTimestamp } from "../db/sqlite_types";

/**
 * What one visit to a reported site found, and with it which layer of the
 * site's infrastructure acted on it (see `siteCheckLayer`):
 *
 * - `online`: the site answered with content.
 * - `redirected`: the site sent the visit to another registrable domain. A kit
 *   cloaking a non-victim and a site that moved look alike, so it is not down.
 * - `unreachable`: no answer (timeout, refused connection, TLS failure, 5xx).
 *   Servers fail for many reasons; only repeated it counts as down.
 * - `removed`: the server answers, but the page is gone (404, 410).
 * - `host_suspended`: the hosting provider's suspension page.
 * - `cdn_blocked`: the CDN's phishing interstitial in front of the site.
 * - `parked`: a parking or for-sale page replaced the site.
 * - `domain_suspended`: the registry or registrar put the domain on hold.
 * - `domain_gone`: the domain no longer resolves (NXDOMAIN).
 */
export const siteCheckStates = [
	"online",
	"redirected",
	"unreachable",
	"removed",
	"host_suspended",
	"cdn_blocked",
	"parked",
	"domain_suspended",
	"domain_gone",
] as const;
export type SiteCheckState = (typeof siteCheckStates)[number];

/** One liveness check of a reported site, kept forever as the takedown record of its target. */
export const siteChecks = sqliteTable(
	"site_checks",
	{
		id: sqliteBigint("id").primaryKey(),
		reportId: sqliteBigint("report_id")
			.notNull()
			.references(() => abuseReports.id, { onDelete: "cascade" }),
		targetId: sqliteBigint("target_id")
			.notNull()
			.references(() => abuseTargets.id, { onDelete: "cascade" }),
		/** The reported address that was visited. */
		url: text("url").notNull(),
		state: text("state", { enum: siteCheckStates }).notNull(),
		httpStatus: sqliteInteger("http_status"),
		/** Where the visit ended after redirects. */
		finalUrl: text("final_url"),
		resolvedAddresses: text("resolved_addresses", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
		/** The domain's RDAP status values (`client hold`, `server hold`, …). */
		domainStatuses: text("domain_statuses", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
		/** What decided the state, in plain words: the matched page signature or the network error. */
		detail: text("detail"),
		checkedAt: sqliteTimestamp("checked_at").notNull(),
	},
	(table) => [index("site_checks_target_checked_idx").on(table.targetId, table.checkedAt)],
);
export type SiteCheck = InferSelectModel<typeof siteChecks>;
