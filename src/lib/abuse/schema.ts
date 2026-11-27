import { InferSelectModel, sql } from "drizzle-orm";
import { blob, index, int, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sqliteBigint, sqliteInteger, sqliteTimestamp } from "../db/sqlite_types";
import { submissions } from "../db/schema";
import { campaigns } from "../campaign/schema";

export const abuseReportStatuses = [
	/** Accepted, and evidence about the reported site is still being collected; no provider has been contacted. */
	"investigating",
	"accepted",
	"resolving",
	"verifying",
	"queued",
	"running",
	"waiting_provider",
	"partially_submitted",
	"submitted",
	"insufficient_evidence",
	"no_route",
	"failed",
	"needs_human",
	"canceled",
] as const;
export type AbuseReportStatus = (typeof abuseReportStatuses)[number];

/**
 * `email` targets the phishing message itself; its routes need the stored message evidence.
 * `campaign` is a criminal referral's subject: every site of one campaign, reported to an authority.
 */
export const abuseTargetTypes = ["domain", "ip", "email", "service_account", "campaign"] as const;
export type AbuseTargetType = (typeof abuseTargetTypes)[number];

export const abuseTargetStatuses = ["pending", "resolved", "no_route", "failed"] as const;
export type AbuseTargetStatus = (typeof abuseTargetStatuses)[number];

export const abuseRouteTypes = ["email", "provider_submission", "manual_unroutable"] as const;
export type AbuseRouteType = (typeof abuseRouteTypes)[number];

export const abuseRouteStatuses = [
	/** A drafted mail the operator must approve before it is sent; criminal referrals start here. */
	"awaiting_approval",
	/** The operator decided a drafted mail is not sent. */
	"discarded",
	"resolving",
	"verified",
	"queued",
	"running",
	"submitted",
	"awaiting_provider_reply",
	"escalating_to_portal",
	"acknowledged",
	"provider_rejected",
	"delivery_failed",
	"insufficient_evidence",
	"no_route",
	"failed",
	"needs_human",
	"unknown_external_state",
] as const;
export type AbuseRouteStatus = (typeof abuseRouteStatuses)[number];

export const abuseRunStatuses = [
	"pending",
	"starting",
	// A browser task agent may be acting on the provider's form. A restart in
	// this state must fail closed rather than run the task again.
	"task_started",
	// A direct provider submission may have crossed its provider boundary. A
	// restart in this state must be reconciled rather than automatically submit
	// the same complaint again.
	"submission_started",
	"running",
	"delivered",
	"completed",
	"failed",
	"unknown_external_state",
	"canceled",
] as const;
export type AbuseRunStatus = (typeof abuseRunStatuses)[number];

export const jobStatuses = ["queued", "running", "completed", "failed", "unknown_external_state"] as const;
export type JobStatus = (typeof jobStatuses)[number];

export const jobTypes = [
	"resolve_report",
	"send_email",
	"monitor_provider_reply",
	"run_portal",
	"submit_provider",
	"classify_provider_reply",
	"poll_provider_correspondence",
	"find_provider_receipt",
	"investigate_report",
	/** The redirector and data drops of a case whose site another case's open report covers, reported against that report. */
	"investigate_joined_case",
	"follow_up_provider_decision",
	"report_origin_host",
	"search_campaign_kits",
	"analyze_kit_sibling",
	"watch_redirector",
	"link_campaign",
	"describe_campaign",
	/** Visit a reported site on its schedule after the report and record whether it is still up. */
	"check_site_liveness",
	/** Tell the new host, the CDN the site left and the registrar that a reported site moved and still serves what was reported. */
	"report_host_move",
	/** Take the due steps of a reported site's escalation ladder while it still serves what was reported (abuse/escalation). */
	"escalate_target",
	/** Visit a submitted website and analyze it (website/visit_queue): every website analysis runs as one. */
	"visit_website",
] as const;
export type JobType = (typeof jobTypes)[number];

export const abuseMailDirections = ["outbound", "inbound"] as const;
export type AbuseMailDirection = (typeof abuseMailDirections)[number];

export const abuseMailClassifications = [
	"acknowledged",
	"not_monitored",
	"needs_more_information",
	"rejected",
	"bounce",
	/** Our own mail relay refused to send the report (see mail/relay_refusal.ts): the provider never saw it. */
	"relay_refused",
	"ambiguous",
] as const;
export type AbuseMailClassification = (typeof abuseMailClassifications)[number];

/**
 * The single reporting aggregate. Website and email submissions own their
 * reports through `submissionId` (a website case one per reported site of its
 * chain); public API reports carry the submitter's
 * name/email instead. Providers always see the phishing.support service
 * identity, with any submitter named only inside the report text.
 */
export const abuseReports = sqliteTable(
	"abuse_reports",
	{
		id: sqliteBigint("id").primaryKey(),
		submissionId: sqliteBigint("submission_id").references(() => submissions.id, { onDelete: "cascade" }),
		/** The campaign a criminal referral reports; such a report has no submission. */
		campaignId: sqliteBigint("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
		trackingTokenHash: text("tracking_token_hash").notNull(),
		idempotencyKey: text("idempotency_key"),
		requestPayloadHash: text("request_payload_hash").notNull(),
		allegationCategory: text("allegation_category").notNull(),
		description: text("description").notNull(),
		legalBrandUrl: text("legal_brand_url"),
		/**
		 * The User-Agent a reviewer must send to see the reported content. A
		 * payload host serves its script only to the command's downloader and
		 * answers a browser with 404.
		 */
		reportedUserAgent: text("reported_user_agent"),
		reporterName: text("reporter_name"),
		reporterContactEmail: text("reporter_contact_email"),
		status: text("status", { enum: abuseReportStatuses }).notNull().default("accepted"),
		requesterIp: text("requester_ip"),
		requesterCountry: text("requester_country"),
		requesterHeaders: text("requester_headers", { mode: "json" }).$type<Record<string, string>>(),
		createdAt: sqliteTimestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
		updatedAt: sqliteTimestamp("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("abuse_reports_tracking_token_hash_unique").on(table.trackingTokenHash),
		uniqueIndex("abuse_reports_idempotency_key_unique").on(table.idempotencyKey),
		index("abuse_reports_submission_idx").on(table.submissionId),
		// One referral report per campaign; its routes are the mails to every recipient.
		uniqueIndex("abuse_reports_campaign_unique").on(table.campaignId),
		index("abuse_reports_status_updated_idx").on(table.status, table.updatedAt),
	]
);

/**
 * A case that confirmed a site another case's open report already covers.
 * Instead of a second report to the same providers, the existing report names
 * the case (a `report.case_joined` event) and the case shows the report.
 */
export const abuseReportCases = sqliteTable(
	"abuse_report_cases",
	{
		id: sqliteBigint("id").primaryKey(),
		reportId: sqliteBigint("report_id")
			.notNull()
			.references(() => abuseReports.id, { onDelete: "cascade" }),
		submissionId: sqliteBigint("submission_id")
			.notNull()
			.references(() => submissions.id, { onDelete: "cascade" }),
		createdAt: sqliteTimestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("abuse_report_cases_report_submission_unique").on(table.reportId, table.submissionId),
		index("abuse_report_cases_submission_idx").on(table.submissionId),
	]
);

/** One normalized target with every original occurrence retained in JSON provenance. */
export const abuseTargets = sqliteTable(
	"abuse_targets",
	{
		id: sqliteBigint("id").primaryKey(),
		reportId: sqliteBigint("report_id")
			.notNull()
			.references(() => abuseReports.id, { onDelete: "cascade" }),
		ordinal: sqliteInteger("ordinal").notNull(),
		originalInput: text("original_input").notNull(),
		originalInputs: text("original_inputs", { mode: "json" }).$type<string[]>().notNull(),
		normalizedTarget: text("normalized_target").notNull(),
		targetType: text("target_type", { enum: abuseTargetTypes }).notNull(),
		observedUrls: text("observed_urls", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
		resolutionStatus: text("resolution_status", { enum: abuseTargetStatuses }).notNull().default("pending"),
		resolverSnapshot: text("resolver_snapshot", { mode: "json" }).$type<Record<string, unknown>>(),
		disposition: text("disposition"),
		createdAt: sqliteTimestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
		updatedAt: sqliteTimestamp("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("abuse_targets_report_normalized_unique").on(table.reportId, table.normalizedTarget),
		index("abuse_targets_report_ordinal_idx").on(table.reportId, table.ordinal),
	]
);

/** A resolved provider route, including explicit resolver provenance and definition pinning. */
export const abuseProviderRoutes = sqliteTable(
	"abuse_provider_routes",
	{
		id: sqliteBigint("id").primaryKey(),
		reportId: sqliteBigint("report_id")
			.notNull()
			.references(() => abuseReports.id, { onDelete: "cascade" }),
		targetId: sqliteBigint("target_id")
			.notNull()
			.references(() => abuseTargets.id, { onDelete: "cascade" }),
		routeKey: text("route_key").notNull(),
		providerRegistryKey: text("provider_registry_key").notNull(),
		providerDisplayName: text("provider_display_name").notNull(),
		routeType: text("route_type", { enum: abuseRouteTypes }).notNull(),
		verifiedEmail: text("verified_email"),
		providerDefinitionVersion: text("provider_definition_version"),
		providerDefinitionHash: text("provider_definition_hash"),
		resolverProvenance: text("resolver_provenance", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
		resolutionSnapshot: text("resolution_snapshot", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
		/** The authority's file number for the case this route reported (Aktenzeichen, Tagebuchnummer). */
		caseReference: text("case_reference"),
		status: text("status", { enum: abuseRouteStatuses }).notNull().default("resolving"),
		createdAt: sqliteTimestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
		updatedAt: sqliteTimestamp("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("abuse_provider_routes_target_route_key_unique").on(table.targetId, table.routeKey),
		index("abuse_provider_routes_report_status_idx").on(table.reportId, table.status),
		index("abuse_provider_routes_target_idx").on(table.targetId),
	]
);

/** Immutable snapshots for every external provider attempt. */
export const abuseProviderRuns = sqliteTable(
	"abuse_provider_runs",
	{
		id: sqliteBigint("id").primaryKey(),
		reportId: sqliteBigint("report_id")
			.notNull()
			.references(() => abuseReports.id, { onDelete: "cascade" }),
		routeId: sqliteBigint("route_id")
			.notNull()
			.references(() => abuseProviderRoutes.id, { onDelete: "cascade" }),
		providerPayload: text("provider_payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
		payloadHash: text("payload_hash").notNull(),
		correlationKey: text("correlation_key").notNull(),
		attemptCount: sqliteInteger("attempt_count").notNull().default(0),
		executionStatus: text("execution_status", { enum: abuseRunStatuses }).notNull().default("pending"),
		confirmationId: text("confirmation_id"),
		confirmationText: text("confirmation_text"),
		finalUrl: text("final_url"),
		submittedTargets: text("submitted_targets", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
		failureReason: text("failure_reason"),
		createdAt: sqliteTimestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
		updatedAt: sqliteTimestamp("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("abuse_provider_runs_correlation_key_unique").on(table.correlationKey),
		index("abuse_provider_runs_route_created_idx").on(table.routeId, table.createdAt),
		index("abuse_provider_runs_status_updated_idx").on(table.executionStatus, table.updatedAt),
	]
);

/** Permanent, report-owned content-addressed evidence and external artifacts. */
export const abuseArtifacts = sqliteTable(
	"abuse_artifacts",
	{
		id: sqliteBigint("id").primaryKey(),
		reportId: sqliteBigint("report_id")
			.notNull()
			.references(() => abuseReports.id, { onDelete: "cascade" }),
		targetId: sqliteBigint("target_id").references(() => abuseTargets.id, { onDelete: "set null" }),
		routeId: sqliteBigint("route_id").references(() => abuseProviderRoutes.id, { onDelete: "set null" }),
		runId: sqliteBigint("run_id").references(() => abuseProviderRuns.id, { onDelete: "set null" }),
		name: text("name").notNull(),
		kind: text("kind").notNull(),
		mimeType: text("mime_type").notNull(),
		sha256: text("sha256").notNull(),
		size: sqliteInteger("size").notNull(),
		metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
		blob: blob("blob").notNull().$type<Buffer>(),
		createdAt: sqliteTimestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		// A hash identifies bytes, not an artifact occurrence. The same bytes can
		// legitimately be an original upload, a provider derivative, a MIME part,
		// or evidence for distinct routes. Keep every immutable occurrence and use
		// a non-unique lookup index instead of collapsing their metadata.
		index("abuse_artifacts_report_sha_size_idx").on(table.reportId, table.sha256, table.size),
		index("abuse_artifacts_report_kind_created_idx").on(table.reportId, table.kind, table.createdAt),
		index("abuse_artifacts_run_idx").on(table.runId),
	]
);

/** Complete inbound/outbound provider correspondence and its IMAP idempotency record. */
export const abuseMailMessages = sqliteTable(
	"abuse_mail_messages",
	{
		id: sqliteBigint("id").primaryKey(),
		reportId: sqliteBigint("report_id")
			.notNull()
			.references(() => abuseReports.id, { onDelete: "cascade" }),
		routeId: sqliteBigint("route_id")
			.notNull()
			.references(() => abuseProviderRoutes.id, { onDelete: "cascade" }),
		runId: sqliteBigint("run_id").references(() => abuseProviderRuns.id, { onDelete: "set null" }),
		direction: text("direction", { enum: abuseMailDirections }).notNull(),
		kind: text("kind").notNull(),
		status: text("status").notNull(),
		fromAddress: text("from_address"),
		toAddresses: text("to_addresses", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
		subject: text("subject"),
		textBody: text("text_body"),
		messageId: text("message_id"),
		inReplyTo: text("in_reply_to"),
		references: text("references", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
		replyAddress: text("reply_address"),
		correlationKey: text("correlation_key"),
		classification: text("classification", { enum: abuseMailClassifications }),
		rawArtifactId: sqliteBigint("raw_artifact_id").references(() => abuseArtifacts.id, { onDelete: "set null" }),
		attachmentArtifactIds: text("attachment_artifact_ids", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
		imapMailbox: text("imap_mailbox"),
		imapUidValidity: sqliteInteger("imap_uidvalidity"),
		imapUid: sqliteInteger("imap_uid"),
		processingAttempts: sqliteInteger("processing_attempts").notNull().default(0),
		disposition: text("disposition"),
		error: text("error"),
		occurredAt: sqliteTimestamp("occurred_at").notNull(),
		createdAt: sqliteTimestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
		updatedAt: sqliteTimestamp("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("abuse_mail_messages_imap_uid_unique").on(table.imapMailbox, table.imapUidValidity, table.imapUid),
		index("abuse_mail_messages_route_occurred_idx").on(table.routeId, table.occurredAt),
		index("abuse_mail_messages_message_id_idx").on(table.messageId),
		index("abuse_mail_messages_reply_address_idx").on(table.replyAddress),
	]
);

/** Durable worker jobs. No process-local stream is used as execution state. */
export const jobs = sqliteTable(
	"jobs",
	{
		id: sqliteBigint("id").primaryKey(),
		jobType: text("job_type", { enum: jobTypes }).notNull(),
		reportId: sqliteBigint("report_id").references(() => abuseReports.id, { onDelete: "cascade" }),
		routeId: sqliteBigint("route_id").references(() => abuseProviderRoutes.id, { onDelete: "cascade" }),
		runId: sqliteBigint("run_id").references(() => abuseProviderRuns.id, { onDelete: "cascade" }),
		payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
		dedupeKey: text("dedupe_key"),
		/**
		 * The share a job counts against in a fair-share lane (`JobClaimFilter.fairShare`):
		 * the reporter whose submission caused it, so one reporter cannot take every slot.
		 */
		fairKey: text("fair_key"),
		/** At most one job per key runs at a time: a provider route's, a site group's visits. */
		serialKey: text("serial_key"),
		status: text("status", { enum: jobStatuses }).notNull().default("queued"),
		leaseOwner: text("lease_owner"),
		leaseExpiresAt: sqliteTimestamp("lease_expires_at"),
		retryCount: sqliteInteger("retry_count").notNull().default(0),
		nextAttemptAt: sqliteTimestamp("next_attempt_at").notNull(),
		unknownExternalState: int("unknown_external_state", { mode: "boolean" }).notNull().default(false),
		lastError: text("last_error"),
		createdAt: sqliteTimestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
		updatedAt: sqliteTimestamp("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		index("jobs_claim_idx").on(table.status, table.nextAttemptAt, table.leaseExpiresAt),
		index("jobs_route_status_idx").on(table.routeId, table.status),
		index("jobs_dedupe_idx").on(table.dedupeKey, table.status),
		index("jobs_serial_status_idx").on(table.serialKey, table.status),
		index("jobs_type_fair_status_idx").on(table.jobType, table.fairKey, table.status),
	]
);

/** Append-only audit trail. Events are never updated or deleted by the service. */
export const abuseEvents = sqliteTable(
	"abuse_events",
	{
		id: sqliteBigint("id").primaryKey(),
		reportId: sqliteBigint("report_id")
			.notNull()
			.references(() => abuseReports.id, { onDelete: "cascade" }),
		targetId: sqliteBigint("target_id").references(() => abuseTargets.id, { onDelete: "set null" }),
		routeId: sqliteBigint("route_id").references(() => abuseProviderRoutes.id, { onDelete: "set null" }),
		runId: sqliteBigint("run_id").references(() => abuseProviderRuns.id, { onDelete: "set null" }),
		jobId: sqliteBigint("job_id").references(() => jobs.id, { onDelete: "set null" }),
		eventType: text("event_type").notNull(),
		data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
		createdAt: sqliteTimestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		index("abuse_events_report_created_idx").on(table.reportId, table.createdAt),
		index("abuse_events_route_created_idx").on(table.routeId, table.createdAt),
	]
);

/** Lease-backed singleton locks for provider-owned external resources. */
export const abuseLocks = sqliteTable(
	"abuse_locks",
	{
		lockKey: text("lock_key").primaryKey(),
		owner: text("owner").notNull(),
		leaseExpiresAt: sqliteTimestamp("lease_expires_at").notNull(),
		updatedAt: sqliteTimestamp("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [index("abuse_locks_lease_idx").on(table.leaseExpiresAt)]
);

/**
 * Logged-in provider account sessions (providers/login_session), one per
 * provider account. Short-lived credentials are isolated from immutable report
 * payloads and audit events.
 */
export const providerLoginSessions = sqliteTable("provider_login_sessions", {
	sessionKey: text("session_key").primaryKey(),
	session: text("session", { mode: "json" }).$type<Record<string, unknown>>(),
	expiresAt: sqliteInteger("expires_at"),
	failureMessage: text("failure_message"),
	failureUntil: sqliteInteger("failure_until"),
	updatedAt: sqliteInteger("updated_at").notNull(),
});

export type AbuseReport = InferSelectModel<typeof abuseReports>;
export type AbuseTarget = InferSelectModel<typeof abuseTargets>;
export type AbuseProviderRoute = InferSelectModel<typeof abuseProviderRoutes>;
export type AbuseProviderRun = InferSelectModel<typeof abuseProviderRuns>;
export type AbuseArtifact = InferSelectModel<typeof abuseArtifacts>;
export type AbuseMailMessage = InferSelectModel<typeof abuseMailMessages>;
export type Job = InferSelectModel<typeof jobs>;
export type AbuseEvent = InferSelectModel<typeof abuseEvents>;
