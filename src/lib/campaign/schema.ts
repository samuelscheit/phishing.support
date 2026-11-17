import { InferSelectModel, sql } from "drizzle-orm";
import { index, int, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { submissions } from "../db/schema";
import { sqliteBigint, sqliteInteger, sqliteTimestamp } from "../db/sqlite_types";

/**
 * What a confirmed site shows about who runs it.
 *
 * - `exfiltration_backend`: where the site sent the synthetic values a visit entered (a Telegram bot, a Discord webhook, a collector host).
 * - `payment_receiver`: an account the page asks visitors to pay (IBAN, crypto wallet).
 * - `kit_fingerprint`: the SHA-256 of a script or hidden-frame document of the kit itself, not of a public library.
 * - `origin_ip`: the server behind the site; it describes the infrastructure but never links sites, because shared hosting puts unrelated operators on one address.
 */
export const campaignIndicatorKinds = ["exfiltration_backend", "payment_receiver", "kit_fingerprint", "origin_ip"] as const;
export type CampaignIndicatorKind = (typeof campaignIndicatorKinds)[number];

/** A set of confirmed sites linked by at least one indicator only one operator has. */
export const campaigns = sqliteTable(
	"campaigns",
	{
		id: sqliteBigint("id").primaryKey(),
		/** Set when another campaign absorbed this one; its referrals stay on record under the old id. */
		mergedInto: sqliteBigint("merged_into"),
		/** What the public page calls the campaign, written from its sites' analyses. */
		title: text("title"),
		/** Two or three plain sentences: what the sites do, to whom, and why they are one operator's. */
		summary: text("summary"),
		/** How many sites the title and summary describe; a different count means they are rewritten. */
		summarySiteCount: sqliteInteger("summary_site_count"),
		summaryGeneratedAt: sqliteTimestamp("summary_generated_at"),
		createdAt: sqliteTimestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
		updatedAt: sqliteTimestamp("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [index("campaigns_merged_into_idx").on(table.mergedInto)],
);

export const campaignMembers = sqliteTable(
	"campaign_members",
	{
		submissionId: sqliteBigint("submission_id")
			.primaryKey()
			.references(() => submissions.id, { onDelete: "cascade" }),
		campaignId: sqliteBigint("campaign_id")
			.notNull()
			.references(() => campaigns.id, { onDelete: "cascade" }),
		joinedAt: sqliteTimestamp("joined_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [index("campaign_members_campaign_idx").on(table.campaignId, table.joinedAt)],
);

/**
 * What the public page shows of one site beyond its submission: the
 * language its captured page spoke and a screenshot cut to the page's
 * content. Kept apart from membership, which a regrouping rewrites.
 */
export const campaignSiteFacts = sqliteTable(
	"campaign_site_facts",
	{
		submissionId: sqliteBigint("submission_id")
			.primaryKey()
			.references(() => submissions.id, { onDelete: "cascade" }),
		/** ISO 639-1 code of the captured page's language, when the text was long enough to tell. */
		language: text("language"),
		/** The trimmed screenshot artifact of the analyzed page. */
		thumbnailArtifactId: sqliteBigint("thumbnail_artifact_id"),
		updatedAt: sqliteTimestamp("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
);

export type CampaignIndicatorEvidence = Record<string, unknown>;

/** One indicator one submission showed, with the evidence that proves it. */
export const campaignIndicators = sqliteTable(
	"campaign_indicators",
	{
		id: sqliteBigint("id").primaryKey(),
		submissionId: sqliteBigint("submission_id")
			.notNull()
			.references(() => submissions.id, { onDelete: "cascade" }),
		kind: text("kind", { enum: campaignIndicatorKinds }).notNull(),
		/** The normalized identity two submissions must share to be linked, e.g. `telegram-bot:123`, `iban:DE89…`, a SHA-256. */
		value: text("value").notNull(),
		/** Whether sharing this value puts two sites into one campaign. */
		links: int("links", { mode: "boolean" }).notNull(),
		evidence: text("evidence", { mode: "json" }).$type<CampaignIndicatorEvidence>().notNull(),
		createdAt: sqliteTimestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("campaign_indicators_submission_kind_value_unique").on(table.submissionId, table.kind, table.value),
		index("campaign_indicators_kind_value_idx").on(table.kind, table.value),
	],
);

/** Whether a kit file's SHA-256 is a published library file (jsDelivr knows every npm and GitHub file it serves). */
export const kitHashChecks = sqliteTable("kit_hash_checks", {
	sha256: text("sha256").primaryKey(),
	/** The package file it is, e.g. `npm:jquery@3.7.1/dist/jquery.min.js`; absent when no library has these bytes. */
	library: text("library"),
	checkedAt: sqliteTimestamp("checked_at").notNull(),
});

export type Campaign = InferSelectModel<typeof campaigns>;
export type CampaignMember = InferSelectModel<typeof campaignMembers>;
export type CampaignIndicator = InferSelectModel<typeof campaignIndicators>;
