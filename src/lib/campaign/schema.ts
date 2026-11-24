import { InferSelectModel, sql } from "drizzle-orm";
import { index, int, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { abuseReports } from "../abuse/schema";
import { submissions } from "../db/schema";
import { sqliteBigint, sqliteInteger, sqliteTimestamp } from "../db/sqlite_types";
import type { VisitorGuidance } from "./guidance";

/**
 * What a confirmed site shows about who runs it.
 *
 * - `operator_server`: a server only the operator controls, whatever it did for the site (`evidence.roles`): received the synthetic values a visit entered, or delivered the malware a page makes visitors run or download. A Telegram bot (`telegram-bot:<id>`), a Discord webhook (`discord-webhook:<id>`) or a host (`host:<name>`); a public platform's host is recorded but links nothing.
 * - `payment_receiver`: an account the page asks visitors to pay (IBAN, crypto wallet).
 * - `delivery_command`: the SHA-256 of the template of the command a page makes visitors paste (`evidence.template`): every layer, decoded, with URLs, encoded blobs and printed decoy text blanked out, so a rotated payload host or app name leaves it unchanged. Only a command with an encoded layer, a decoy or several statements links sites; a bare one-liner is shared by unrelated actors.
 * - `kit_fingerprint`: the SHA-256 of a script or hidden-frame document of the kit itself, not of a public library, or of the reported page's body or tag structure (`fileKind` `page_document`, `page_structure`).
 * - `origin_ip`: the server behind the site; it describes the infrastructure but never links sites, because shared hosting puts unrelated operators on one address.
 */
export const campaignIndicatorKinds = ["operator_server", "payment_receiver", "delivery_command", "kit_fingerprint", "origin_ip"] as const;
export type CampaignIndicatorKind = (typeof campaignIndicatorKinds)[number];

/** What an operator server did for a site: receive what visitors entered, or deliver the malware they were made to run or download. */
export type OperatorServerRole = "receives_data" | "delivers_malware";

/** The roles an operator server's evidence names. */
export function operatorServerRoles(evidence: Record<string, unknown>): OperatorServerRole[] {
	return Array.isArray(evidence.roles) ? evidence.roles.filter((role): role is OperatorServerRole => role === "receives_data" || role === "delivers_malware") : [];
}

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
		/** The impersonated brand's own account pages a visitor needs, validated to lie on the brand's domain; made for the brand it names. */
		visitorGuidance: text("visitor_guidance", { mode: "json" }).$type<VisitorGuidance>(),
		createdAt: sqliteTimestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
		updatedAt: sqliteTimestamp("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [index("campaigns_merged_into_idx").on(table.mergedInto)],
);

/**
 * A campaign's member is one confirmed site as one case saw it: the case and
 * the site's primary report. A case whose chain confirmed two sites is two
 * members, in two campaigns or twice in one; a case whose site another
 * case already reports is a member through the report it joined
 * (`abuse_report_cases`), with its own capture of the site as evidence.
 */
const memberColumns = {
	submissionId: sqliteBigint("submission_id")
		.notNull()
		.references(() => submissions.id, { onDelete: "cascade" }),
	/** The primary report of the site: the case's own, or the one it joined. It names the site (its target). */
	reportId: sqliteBigint("report_id")
		.notNull()
		.references(() => abuseReports.id, { onDelete: "cascade" }),
};

export const campaignMembers = sqliteTable(
	"campaign_members",
	{
		...memberColumns,
		campaignId: sqliteBigint("campaign_id")
			.notNull()
			.references(() => campaigns.id, { onDelete: "cascade" }),
		joinedAt: sqliteTimestamp("joined_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		primaryKey({ columns: [table.submissionId, table.reportId] }),
		index("campaign_members_campaign_idx").on(table.campaignId, table.joinedAt),
	],
);

/**
 * What the public page shows of one member beyond its case: the language
 * the site's captured pages spoke and a screenshot of its judged page cut to
 * the page's content. Kept apart from membership, which a regrouping rewrites.
 */
export const campaignSiteFacts = sqliteTable(
	"campaign_site_facts",
	{
		...memberColumns,
		/** ISO 639-1 code of the captured page's language, when the text was long enough to tell. */
		language: text("language"),
		/** The trimmed screenshot artifact of the site's judged page. */
		thumbnailArtifactId: sqliteBigint("thumbnail_artifact_id"),
		/** The judged page's screenshot is one flat colour: nothing a visitor could recognize. */
		blankCapture: int("blank_capture", { mode: "boolean" }).notNull().default(false),
		updatedAt: sqliteTimestamp("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [primaryKey({ columns: [table.submissionId, table.reportId] })],
);

export type CampaignIndicatorEvidence = Record<string, unknown>;

/** One indicator one member showed, with the evidence that proves it. */
export const campaignIndicators = sqliteTable(
	"campaign_indicators",
	{
		id: sqliteBigint("id").primaryKey(),
		...memberColumns,
		kind: text("kind", { enum: campaignIndicatorKinds }).notNull(),
		/** The normalized identity two members must share to be linked, e.g. `telegram-bot:123`, `iban:DE89…`, a SHA-256. */
		value: text("value").notNull(),
		/** Whether sharing this value puts two sites into one campaign. */
		links: int("links", { mode: "boolean" }).notNull(),
		evidence: text("evidence", { mode: "json" }).$type<CampaignIndicatorEvidence>().notNull(),
		createdAt: sqliteTimestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("campaign_indicators_member_kind_value_unique").on(table.submissionId, table.reportId, table.kind, table.value),
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

/** Whether a host kit files are served from is a platform's (`isPlatformHost`), checked again after a while. */
export const kitHostChecks = sqliteTable("kit_host_checks", {
	host: text("host").primaryKey(),
	platform: int("platform", { mode: "boolean" }).notNull(),
	checkedAt: sqliteTimestamp("checked_at").notNull(),
});

export type Campaign = InferSelectModel<typeof campaigns>;
export type CampaignMember = InferSelectModel<typeof campaignMembers>;
export type CampaignIndicator = InferSelectModel<typeof campaignIndicators>;
