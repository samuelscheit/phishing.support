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

export const reportStatus = ["sent", "failed"] as const;
export type ReportStatus = (typeof reportStatus)[number];

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
		mimeType: text("mime_type"),
		sha256: text("sha256"),
		size: int("size"),
		blob: blob("blob").notNull().$type<Buffer>(),
	},
	(table) => [
		index("artifacts_submission_kind_created_idx").on(table.submissionId, table.kind, table.createdAt),
		uniqueIndex("artifacts_sha256_size_unique").on(table.sha256, table.size),
	]
);

export type Artifact = InferSelectModel<typeof artifacts>;

/** Outbound reports (draft/sent/failed). */
export const reports = sqliteTable(
	"reports",
	{
		id: bignum("id").primaryKey(),
		submissionId: bignum("submission_id")
			.notNull()
			.references(() => submissions.id, { onDelete: "cascade" }),
		analysisRunId: bignum("analysis_run_id").references(() => analysisRuns.id, {
			onDelete: "set null",
		}),
		channel: text("channel").notNull().default("email"),
		to: text("to").notNull(),
		subject: text("subject"),
		body: text("body").notNull(),
		status: text("status", { enum: reportStatus }).notNull().default("sent"),
		sentAt: int("sent_at"),
		providerMessageId: text("provider_message_id"),
		// refereence to artifacts table for attachments
		attachmentsArtifactIds: text("attachments_artifact_ids", { mode: "json" }).$type<string[]>(),
		data: text("data", { mode: "json" }),
		createdAt: timestamp("created_at")
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: timestamp("updated_at")
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		index("reports_submission_created_idx").on(table.submissionId, table.createdAt),
		index("reports_to_created_idx").on(table.to, table.createdAt),
		index("reports_status_created_idx").on(table.status, table.createdAt),
	]
);

export type Report = InferSelectModel<typeof reports>;
