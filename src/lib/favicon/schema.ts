import { InferSelectModel, sql } from "drizzle-orm";
import { blob, index, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { sqliteTimestamp } from "../db/sqlite_types";
import type { FetchFailure, IconSource } from "./extract";

/**
 * - `pending`: a page asked for the icon; nothing was fetched yet.
 * - `found`: the icon is stored and served.
 * - `missing`: the last fetch got none; it is asked again at `check_at`.
 */
export const faviconStatuses = ["pending", "found", "missing"] as const;
export type FaviconStatus = (typeof faviconStatuses)[number];

/**
 * The icon of a provider's website, by registrable domain, as the pages show
 * it next to the provider's name: fetched once in the background and kept
 * for good. Every row is also its own refresh job: it is due at `check_at`
 * (a page's first ask, the retry of a missing icon, the rare revalidation of
 * a found one), and `claimed_until` keeps two refreshers off one domain.
 * `png` is always our own re-drawn PNG (see `normalizeIcon`), never the
 * site's file; `version` is its hash, which the served URL carries.
 */
export const favicons = sqliteTable(
	"favicons",
	{
		domain: text("domain").primaryKey(),
		status: text("status", { enum: faviconStatuses }).notNull(),
		png: blob("png").$type<Buffer>(),
		version: text("version"),
		source: text("source", { mode: "json" }).$type<IconSource>(),
		failure: text("failure").$type<FetchFailure>(),
		/** Why the last fetch or revalidation got no icon, for the operator. */
		reason: text("reason"),
		fetchedAt: sqliteTimestamp("fetched_at"),
		checkAt: sqliteTimestamp("check_at").notNull(),
		claimedUntil: sqliteTimestamp("claimed_until"),
		createdAt: sqliteTimestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [index("favicons_check_at_idx").on(table.checkAt)],
);

export type Favicon = InferSelectModel<typeof favicons>;
