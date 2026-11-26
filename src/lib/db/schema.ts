import { InferSelectModel, sql } from "drizzle-orm";
import { blob, index, int, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { WhoISInfo } from "../website/info/info";
import { ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses.mjs";
import { MailData } from "../mail/ai";
import { sqliteBigint, sqliteInteger, sqliteTimestamp } from "./sqlite_types";
import type { WebsiteAccessGate } from "../website/visit/access_gate";
import type { ReporterInstructions } from "../submissions/instructions";
import type { WebsiteCloakedDestination, WebsiteCloaking, WebsiteDevice, WebsiteHiddenFrame, WebsiteKitResource, WebsiteOfferedDownload, WebsiteProviderWarning, WebsiteRotation, WebsiteRoute, WebsiteSiteFinding } from "../website/types";

export const submissionKind = ["email", "website"] as const;
export type SubmissionKind = (typeof submissionKind)[number];

export const submissionStatus = ["running", "failed", "reported", "invalid"] as const;
export type SubmissionStatus = (typeof submissionStatus)[number];

export const analysisRunStatus = ["running", "completed", "failed"] as const;
export type AnalysisRunStatus = (typeof analysisRunStatus)[number];

/** Purpose of an analyzer run, used to keep machine-only classifications out of the user-facing report. */
export const analysisRunKind = ["analysis", "classification"] as const;
export type AnalysisRunKind = (typeof analysisRunKind)[number];


export type EmailSubmissionData = MailData & {
	/** The website case each linked page was handed to; several links may share one case. */
	linkedWebsites?: Array<{ url: string; submissionId: string }>;
};

export type WebsiteSubmissionData = {
	whois?: WhoISInfo;
	url: string;
	/** What the reporter asked the visit to do and the analysis to know; shown on the case page. */
	instructions?: ReporterInstructions;
	/** URL of the page the case's verdict rests on (the analyzed page of route `analyzedRoute`); it may be on another site than the submitted URL. */
	archiveUrl?: string;
	/** Every route a walk of the submitted link took; the first walk's is route 0. */
	routes?: WebsiteRoute[];
	/** The route of the page the case's verdict rests on (`archiveUrl`): the first route with a reportable finding, else route 0. Absent means 0. */
	analyzedRoute?: number;
	/** The extra visits that sampled a rotating link's other routes; set when the first walk passed a tracking link. */
	rotation?: WebsiteRotation;
	/** How the capture handled the submitted page's scripted jump to another site. */
	cloaking?: WebsiteCloaking;
	/** How visitors got into the reported page, when it is not shown to everyone who opens it; set when the report is filed. */
	accessGate?: WebsiteAccessGate;
	/** Set when the captured page sat behind the kit's own "I'm not a robot" gate, which the capture clicked through. */
	verificationGate?: { label: string };
	/** Scripts and stylesheets, from any host, received by the live capture; absent for uploaded or retained MHTML. */
	kitResources?: WebsiteKitResource[];
	/**
	 * For a capture that recorded no kit files: those of a urlscan.io scan of the
	 * site whose page showed the same text as ours (`scan`), or none when no scan
	 * matched; `checkedAt` is when urlscan was asked.
	 */
	urlscanKit?: {
		checkedAt: string;
		scan?: { id: string; url: string; scannedAt: string; textMatch: number };
		resources: WebsiteKitResource[];
	};
	/** Frames of the analyzed page no visitor can see, with the code they loaded; absent for uploaded MHTML. */
	hiddenFrames?: WebsiteHiddenFrame[];
	/** The phone the analyzed page was captured as, when it turned desktops away. */
	device?: WebsiteDevice;
	/** A provider's own warning page (Cloudflare's "Suspected Phishing") the capture dismissed before the site. */
	providerWarning?: WebsiteProviderWarning;
	/** The file the visit downloaded on the analyzed page, with its static inspection. */
	offeredDownload?: WebsiteOfferedDownload;
	/** Set when a failure another visit can change ended the run; the analysis is re-queued automatically. */
	autoRetry?: { attempts: number; nextAttemptAt: string; reason: string };
	/** Why the capture could not finish the site's flow: the step it could not take. A retry visits the site again. */
	unfinishedFlow?: string;
	/** Set when the site's flow led to a site that answered every network tried with an empty response and sent the visit back: no verdict, no report. */
	cloakedDestination?: WebsiteCloakedDestination;
	/** Evidence collected after the verdict and before the report reaches any provider. */
	investigation?: {
		status: "queued" | "running" | "completed" | "failed";
		/** Data drops (Telegram bots, Discord webhooks, collector hosts) the form probe found. */
		backendCount?: number;
		/** Payloads fetched from the commands the page tells visitors to run. */
		payloads?: Array<{ url: string; sha256?: string; sizeBytes?: number; verdict?: string; error?: string }>;
		/** Why the form probe could not run, when it failed; the report is still sent. */
		probeError?: string;
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
		status: text("status", { enum: submissionStatus }).notNull().default("running"),
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

/** Who started a retry: someone pressing "Analyze again", or the server re-queuing a case on its own. */
export const submissionRetryTrigger = ["manual", "automatic"] as const;
export type SubmissionRetryTrigger = (typeof submissionRetryTrigger)[number];

/**
 * Every time a failed or unreported case was analyzed again, with what it
 * stood at before: its status, its info line and its finding (a website's
 * verdict on its headline page; an email keeps none). Written in the same
 * transaction that claims the case for the retry, so each started retry has
 * exactly one row and a refused or lost claim has none.
 */
export const submissionRetries = sqliteTable(
	"submission_retries",
	{
		id: sqliteBigint("id").primaryKey(),
		submissionId: sqliteBigint("submission_id")
			.notNull()
			.references(() => submissions.id, { onDelete: "cascade" }),
		fromStatus: text("from_status", { enum: submissionStatus }).notNull(),
		previousInfo: text("previous_info"),
		previousFinding: text("previous_finding").$type<WebsiteSiteFinding>(),
		trigger: text("trigger", { enum: submissionRetryTrigger }).notNull(),
		createdAt: sqliteTimestamp("created_at")
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		index("submission_retries_submission_created_idx").on(table.submissionId, table.createdAt),
		index("submission_retries_created_idx").on(table.createdAt),
	]
);

export type SubmissionRetry = InferSelectModel<typeof submissionRetries>;

/** Analyzer execution runs. */
export const analysisRuns = sqliteTable(
	"analysis_runs",
	{
		id: sqliteBigint("id").primaryKey(),
		submissionId: sqliteBigint("submission_id")
			.notNull()
			.references(() => submissions.id, { onDelete: "cascade" }),
		status: text("status", { enum: analysisRunStatus }).notNull().default("running"),
		analysisKind: text("analysis_kind", { enum: analysisRunKind }).notNull(),
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
export * from "../campaign/schema";
export * from "../liveness/schema";
export * from "../favicon/schema";
