import { InferSelectModel, sql } from "drizzle-orm";
import { blob, customType, index, int, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { WhoISInfo } from "../website_info";
import { ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses.mjs";
import { MailData } from "../mail_ai";

export const submissionKind = ["email", "website"] as const;
export type SubmissionKind = (typeof submissionKind)[number];

export const submissionStatus = ["new", "queued", "running", "failed", "reported", "invalid"] as const;
export type SubmissionStatus = (typeof submissionStatus)[number];

export const analysisRunStatus = ["running", "completed", "failed"] as const;
export type AnalysisRunStatus = (typeof analysisRunStatus)[number];

/** Purpose of an analyzer run, used to keep machine-only classifications out of the user-facing report. */
export const analysisRunKind = ["analysis", "classification", "report_draft", "unknown"] as const;
export type AnalysisRunKind = (typeof analysisRunKind)[number];

export const providerReportStatus = ["pending", "submission_started", "sent", "failed", "unknown_external_state"] as const;
export type ProviderReportStatus = (typeof providerReportStatus)[number];

export const reportThreadStatus = ["pending", "sent", "replied", "delivery_failed", "failed", "closed"] as const;
export type ReportThreadStatus = (typeof reportThreadStatus)[number];

export const reportMessageDirection = ["outbound", "inbound"] as const;
export type ReportMessageDirection = (typeof reportMessageDirection)[number];

export const reportMessageKind = ["report", "reply", "auto_reply", "bounce"] as const;
export type ReportMessageKind = (typeof reportMessageKind)[number];

export const reportMessageStatus = ["pending", "sent", "received", "failed"] as const;
export type ReportMessageStatus = (typeof reportMessageStatus)[number];

export const mailIngestRoute = ["reply", "intake", "ignored", "failed"] as const;
export type MailIngestRoute = (typeof mailIngestRoute)[number];

export type EmailSubmissionData = MailData;

export type WebsiteSubmissionData = {
	whois?: WhoISInfo;
	url: string;
};

export type SubmissionData = { kind: "email"; email?: EmailSubmissionData } | { kind: "website"; website: WebsiteSubmissionData };

const bignum = customType<{ data: bigint; driverData: bigint }>({
	dataType: () => "INTEGER",
	fromDriver: (value) => {
		return BigInt(value);
	},
	// @ts-ignore
	toDriver: (value) => value.toString(),
});

const timestamp = customType<{ data: Date; driverData: bigint }>({
	dataType: () => "INTEGER",
	toDriver: (value) => BigInt(value.getTime()),
	fromDriver: (value) => new Date(Number(value)),
});

export const submissions = sqliteTable(
	"submissions",
	{
		id: bignum("id").primaryKey(),
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
		createdAt: timestamp("created_at")
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: timestamp("updated_at")
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
		id: bignum("id").primaryKey(),
		submissionId: bignum("submission_id")
			.notNull()
			.references(() => submissions.id, { onDelete: "cascade" }),
		status: text("status", { enum: analysisRunStatus }).notNull().default("running"),
		analysisKind: text("analysis_kind", { enum: analysisRunKind }).notNull().default("unknown"),
		input: text("input", { mode: "json" }).$type<Array<ResponseInputItem>>(),
		output: text("output", { mode: "json" }).$type<Array<ResponseOutputItem>>(),
		tokensUsed: int("tokens_used"),
		data: text("data", { mode: "json" }),
		createdAt: timestamp("created_at")
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => []
);

export type AnalysisRun = InferSelectModel<typeof analysisRuns>;

export const artifacts = sqliteTable(
	"artifacts",
	{
		id: bignum("id").primaryKey(),
		submissionId: bignum("submission_id").references(() => submissions.id, {
			onDelete: "cascade",
		}),
		name: text("name"),
		kind: text("kind").notNull(),
		createdAt: timestamp("created_at")
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		/** When the captured website archive itself was made, if known. */
		archivedAt: timestamp("archived_at"),
		mimeType: text("mime_type"),
		sha256: text("sha256"),
		size: int("size"),
		blob: blob("blob").notNull().$type<Buffer>(),
	},
	(table) => [
		index("artifacts_submission_kind_created_idx").on(table.submissionId, table.kind, table.createdAt),
	]
);

export type Artifact = InferSelectModel<typeof artifacts>;

/** Direct provider submissions and imported legacy report records. */
export const providerReports = sqliteTable(
	"provider_reports",
	{
		id: bignum("id").primaryKey(),
		submissionId: bignum("submission_id")
			.notNull()
			.references(() => submissions.id, { onDelete: "cascade" }),
		analysisRunId: bignum("analysis_run_id").references(() => analysisRuns.id, {
			onDelete: "set null",
		}),
		channel: text("channel").notNull().default("provider"),
		/** Globally unique operation identity for a provider call that must never replay. */
		operationKey: text("operation_key"),
		to: text("to").notNull(),
		subject: text("subject"),
		body: text("body").notNull(),
		status: text("status", { enum: providerReportStatus }).notNull().default("sent"),
		sentAt: timestamp("sent_at"),
		providerMessageId: text("provider_message_id"),
		providerSubmissionUrl: text("provider_submission_url"),
		error: text("error"),
		/** References to rows in the artifacts table. */
		attachmentsArtifactIds: text("attachments_artifact_ids", { mode: "json" }).$type<string[]>(),
		data: text("data", { mode: "json" }),
		/** Imported rows predate correspondence threads and are retained for auditability. */
		legacy: int("legacy", { mode: "boolean" }).notNull().default(false),
		createdAt: timestamp("created_at")
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: timestamp("updated_at")
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		index("provider_reports_submission_created_idx").on(table.submissionId, table.createdAt),
		index("provider_reports_to_created_idx").on(table.to, table.createdAt),
		index("provider_reports_status_created_idx").on(table.status, table.createdAt),
		uniqueIndex("provider_reports_operation_key_unique").on(table.operationKey),
	]
);

export type ProviderReport = InferSelectModel<typeof providerReports>;

/** One correspondence thread for every SMTP abuse report. */
export const reportThreads = sqliteTable(
	"report_threads",
	{
		id: bignum("id").primaryKey(),
		submissionId: bignum("submission_id")
			.notNull()
			.references(() => submissions.id, { onDelete: "cascade" }),
		analysisRunId: bignum("analysis_run_id").references(() => analysisRuns.id, {
			onDelete: "set null",
		}),
		/** Normalized abuse-recipient addresses. */
		to: text("to", { mode: "json" }).$type<string[]>().notNull(),
		subject: text("subject"),
		replyAddress: text("reply_address").notNull(),
		/** Opaque token used only as a diagnostic mail header. */
		replyToken: text("reply_token").notNull(),
		status: text("status", { enum: reportThreadStatus }).notNull().default("pending"),
		data: text("data", { mode: "json" }),
		createdAt: timestamp("created_at")
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: timestamp("updated_at")
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("report_threads_reply_address_unique").on(table.replyAddress),
		uniqueIndex("report_threads_reply_token_unique").on(table.replyToken),
		index("report_threads_submission_created_idx").on(table.submissionId, table.createdAt),
		index("report_threads_status_updated_idx").on(table.status, table.updatedAt),
	]
);

export type ReportThread = InferSelectModel<typeof reportThreads>;

/** Individual inbound and outbound RFC 5322 messages in an abuse-report thread. */
export const reportMessages = sqliteTable(
	"report_messages",
	{
		id: bignum("id").primaryKey(),
		threadId: bignum("thread_id")
			.notNull()
			.references(() => reportThreads.id, { onDelete: "cascade" }),
		direction: text("direction", { enum: reportMessageDirection }).notNull(),
		kind: text("kind", { enum: reportMessageKind }).notNull(),
		status: text("status", { enum: reportMessageStatus }).notNull(),
		from: text("from"),
		to: text("to", { mode: "json" }).$type<string[]>().notNull(),
		cc: text("cc", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
		subject: text("subject"),
		textBody: text("text_body"),
		htmlBody: text("html_body"),
		messageId: text("message_id"),
		inReplyTo: text("in_reply_to"),
		references: text("references", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
		providerMessageId: text("provider_message_id"),
		rawArtifactId: bignum("raw_artifact_id").references(() => artifacts.id, { onDelete: "set null" }),
		attachmentArtifactIds: text("attachment_artifact_ids", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
		occurredAt: timestamp("occurred_at").notNull(),
		/** SMTP acceptance time for outbound reports; timeline ordering stays on occurredAt. */
		sentAt: timestamp("sent_at"),
		error: text("error"),
		createdAt: timestamp("created_at")
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: timestamp("updated_at")
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		index("report_messages_thread_occurred_idx").on(table.threadId, table.occurredAt),
		// Outbound IDs are ours and must never identify two report threads.
		uniqueIndex("report_messages_outbound_message_id_unique")
			.on(table.messageId)
			.where(sql`${table.direction} = 'outbound' and ${table.messageId} is not null`),
		// The same inbound RFC message can be copied into another IMAP UID or
		// mailbox. It is one correspondence event, regardless of the delivery
		// copy, while outbound IDs remain independently indexed for routing.
		uniqueIndex("report_messages_inbound_message_id_unique")
			.on(table.messageId)
			.where(sql`${table.direction} = 'inbound' and ${table.messageId} is not null`),
		index("report_messages_message_id_idx").on(table.messageId),
		index("report_messages_in_reply_to_idx").on(table.inReplyTo),
	]
);

export type ReportMessage = InferSelectModel<typeof reportMessages>;

/** Idempotency and disposition ledger for messages observed through IMAP. */
export const mailIngest = sqliteTable(
	"mail_ingest",
	{
		id: bignum("id").primaryKey(),
		mailbox: text("mailbox").notNull(),
		uidValidity: int("uid_validity").notNull(),
		uid: int("uid").notNull(),
		messageId: text("message_id"),
		route: text("route", { enum: mailIngestRoute }).notNull(),
		reportMessageId: bignum("report_message_id").references(() => reportMessages.id, {
			onDelete: "set null",
		}),
		reason: text("reason"),
		attempts: int("attempts").notNull().default(1),
		/** Failed parsing/storage attempts are retained but are retried on a later listener pass. */
		terminal: int("terminal", { mode: "boolean" }).notNull().default(true),
		processedAt: timestamp("processed_at").notNull(),
		createdAt: timestamp("created_at")
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: timestamp("updated_at")
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

// The standalone abuse-reporting service owns a completely separate schema.
// Re-exporting it here makes the migration generator include both schemas
// without introducing any application-level relationship to legacy submissions.
export * from "../abuse/schema";
