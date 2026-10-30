import { InferSelectModel, sql } from "drizzle-orm";
import { blob, index, int, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { WhoISInfo } from "../website_info";
import { ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses.mjs";
import { MailData } from "../mail_ai";
import { sqliteBigint, sqliteInteger, sqliteTimestamp } from "./sqlite_types";
import type { WebsiteNavigationHop, WebsiteSiteAssessment } from "../website_types";

export const submissionKind = ["email", "website"] as const;
export type SubmissionKind = (typeof submissionKind)[number];

/** `redirected`: the site led to another host, which is analyzed in its own submission. */
export const submissionStatus = ["new", "queued", "running", "failed", "reported", "invalid", "redirected"] as const;
export type SubmissionStatus = (typeof submissionStatus)[number];

export const analysisRunStatus = ["running", "completed", "failed"] as const;
export type AnalysisRunStatus = (typeof analysisRunStatus)[number];

/** Purpose of an analyzer run, used to keep machine-only classifications out of the user-facing report. */
export const analysisRunKind = ["analysis", "classification", "report_draft", "unknown"] as const;
export type AnalysisRunKind = (typeof analysisRunKind)[number];


export type EmailSubmissionData = MailData;

export type WebsiteSubmissionData = {
	whois?: WhoISInfo;
	url: string;
	/** Final URL whose page content was archived; it may differ from the submitted URL. */
	archiveUrl?: string;
	/** Per-response navigation provenance; document content belongs only to contentCaptured hop. */
	navigationHops?: WebsiteNavigationHop[];
	siteAssessments?: WebsiteSiteAssessment[];
	/** Submission that analyzes the host this site redirected to; its id as a decimal string. */
	redirectSubmissionId?: string;
	/** Set when the submitted page cloaks: it showed Tor/datacenter visitors a different site than residential ones. */
	cloaking?: { outcome: "detected" | "unresolved"; detail: string };
	/** Set when the captured page sat behind the kit's own "I'm not a robot" gate, which the capture clicked through. */
	verificationGate?: { label: string };
	/** Durable supplementary probe state; it never changes the phishing verdict. */
	backendProbe?: {
		status: "queued" | "running" | "completed" | "failed";
		backendCount?: number;
		lastError?: string;
		updatedAt: string;
	};
};

export type SubmissionData = { kind: "email"; email?: EmailSubmissionData } | { kind: "website"; website: WebsiteSubmissionData };

export const submissions = sqliteTable(
	"submissions",
	{
		id: sqliteBigint("id").primaryKey(),
		kind: text("kind", { enum: submissionKind }).notNull(),
		source: text("source"),
		data: text("data", { mode: "json" }).$type<SubmissionData>().notNull(),
		dedupeKey: text("dedupe_key").notNull(),
		status: text("status", { enum: submissionStatus }).notNull().default("new"),
		info: text("info"),
		/** Network and client metadata captured when the submission was made via HTTP. */
		reporterIp: text("reporter_ip"),
		reporterCountry: text("reporter_country"),
		reporterHeaders: text("reporter_headers", { mode: "json" }).$type<Record<string, string>>(),
		createdAt: sqliteTimestamp("created_at")
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: sqliteTimestamp("updated_at")
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("submissions_dedupe_key_unique").on(table.dedupeKey),
		index("submissions_kind_received_at_idx").on(table.kind),
		index("submissions_status_received_at_idx").on(table.status),
		index("submissions_source_idx").on(table.source),
	]
);

export type Submission = InferSelectModel<typeof submissions>;

/** Analyzer execution runs. */
export const analysisRuns = sqliteTable(
	"analysis_runs",
	{
		id: sqliteBigint("id").primaryKey(),
		submissionId: sqliteBigint("submission_id")
			.notNull()
			.references(() => submissions.id, { onDelete: "cascade" }),
		status: text("status", { enum: analysisRunStatus }).notNull().default("running"),
		analysisKind: text("analysis_kind", { enum: analysisRunKind }).notNull().default("unknown"),
		input: text("input", { mode: "json" }).$type<Array<ResponseInputItem>>(),
		output: text("output", { mode: "json" }).$type<Array<ResponseOutputItem>>(),
		tokensUsed: sqliteInteger("tokens_used"),
		data: text("data", { mode: "json" }),
		createdAt: sqliteTimestamp("created_at")
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => []
);

export type AnalysisRun = InferSelectModel<typeof analysisRuns>;

export const artifacts = sqliteTable(
	"artifacts",
	{
		id: sqliteBigint("id").primaryKey(),
		submissionId: sqliteBigint("submission_id").references(() => submissions.id, {
			onDelete: "cascade",
		}),
		name: text("name"),
		kind: text("kind").notNull(),
		createdAt: sqliteTimestamp("created_at")
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		/** When the captured website archive itself was made, if known. */
		archivedAt: sqliteTimestamp("archived_at"),
		mimeType: text("mime_type"),
		sha256: text("sha256"),
		size: sqliteInteger("size"),
		blob: blob("blob").notNull().$type<Buffer>(),
	},
	(table) => [
		index("artifacts_submission_kind_created_idx").on(table.submissionId, table.kind, table.createdAt),
	]
);

export type Artifact = InferSelectModel<typeof artifacts>;

export const mailIngestRoute = ["reply", "intake", "ignored", "failed"] as const;
export type MailIngestRoute = (typeof mailIngestRoute)[number];

/**
 * Idempotency and disposition ledger for every message observed in the
 * monitored mailbox. Replies are stored as `abuse_mail_messages`; intake mail
 * becomes a submission; everything else is recorded as ignored.
 */
export const mailIngest = sqliteTable(
	"mail_ingest",
	{
		id: sqliteBigint("id").primaryKey(),
		mailbox: text("mailbox").notNull(),
		uidValidity: sqliteInteger("uid_validity").notNull(),
		uid: sqliteInteger("uid").notNull(),
		messageId: text("message_id"),
		route: text("route", { enum: mailIngestRoute }).notNull(),
		reason: text("reason"),
		attempts: sqliteInteger("attempts").notNull().default(1),
		/** Failed parsing/storage attempts are retained but are retried on a later listener pass. */
		terminal: int("terminal", { mode: "boolean" }).notNull().default(true),
		processedAt: sqliteTimestamp("processed_at").notNull(),
		createdAt: sqliteTimestamp("created_at")
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: sqliteTimestamp("updated_at")
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("mail_ingest_mailbox_uid_unique").on(table.mailbox, table.uidValidity, table.uid),
		index("mail_ingest_message_id_idx").on(table.messageId),
		index("mail_ingest_route_processed_idx").on(table.route, table.processedAt),
	]
);

export type MailIngest = InferSelectModel<typeof mailIngest>;

// The reporting aggregate lives in the abuse schema. Re-exporting it keeps
// one migration history for both schemas.
export * from "../abuse/schema";
