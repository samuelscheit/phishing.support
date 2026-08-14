import { InferSelectModel, sql } from "drizzle-orm";
import { blob, customType, index, int, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const abuseReportStatuses = [
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

export const abuseTargetTypes = ["domain", "ip"] as const;
export type AbuseTargetType = (typeof abuseTargetTypes)[number];

export const abuseTargetStatuses = ["pending", "resolved", "no_route", "failed"] as const;
export type AbuseTargetStatus = (typeof abuseTargetStatuses)[number];

export const abuseRouteTypes = ["email", "skyvern_portal", "manual_unroutable"] as const;
export type AbuseRouteType = (typeof abuseRouteTypes)[number];

export const abuseRouteStatuses = [
	"resolving",
	"verified",
	"queued",
	"running",
	"waiting_code",
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
	// The immutable Skyvern task payload has been persisted and a task-create
	// request may have crossed the provider boundary. A restart in this state
	// must fail closed rather than issue another task creation call.
	"task_creation_started",
	"running",
	"waiting_code",
	"sending_code",
	"delivered",
	"completed",
	"failed",
	"unknown_external_state",
	"canceled",
] as const;
export type AbuseRunStatus = (typeof abuseRunStatuses)[number];

export const abuseJobStatuses = ["queued", "running", "completed", "failed", "unknown_external_state"] as const;
export type AbuseJobStatus = (typeof abuseJobStatuses)[number];

export const abuseJobTypes = [
	"resolve_report",
	"verify_provider",
	"send_email",
	"monitor_provider_reply",
	"run_portal",
	"reconcile_skyvern_run",
	"deliver_provider_verification_code",
	"classify_provider_reply",
] as const;
export type AbuseJobType = (typeof abuseJobTypes)[number];

export const abuseMailDirections = ["outbound", "inbound"] as const;
export type AbuseMailDirection = (typeof abuseMailDirections)[number];

export const abuseMailClassifications = [
	"acknowledged",
	"not_monitored",
	"needs_more_information",
	"rejected",
	"bounce",
	"ambiguous",
] as const;
export type AbuseMailClassification = (typeof abuseMailClassifications)[number];

const bignum = customType<{ data: bigint; driverData: bigint }>({
	dataType: () => "INTEGER",
	fromDriver: (value) => BigInt(value),
	// Drizzle's Bun SQLite adapter accepts a string representation for safe integers.
	// @ts-expect-error drizzle's custom-type driver declaration is narrower than SQLite.
	toDriver: (value) => value.toString(),
});

/**
 * The shared SQLite client runs with `safeIntegers: true`, so every SQLite
 * INTEGER arrives from Bun as a bigint. IDs intentionally retain that exact
 * representation through `bignum`; bounded counters, sizes, ordinals, and
 * IMAP values do not. Mapping those fields here prevents lifecycle arithmetic
 * from mixing bigint and number at every repository/worker call site.
 */
const integer = customType<{ data: number; driverData: bigint }>({
	dataType: () => "INTEGER",
	fromDriver: (value) => {
		const number = Number(value);
		if (!Number.isSafeInteger(number)) throw new RangeError("SQLite integer exceeds JavaScript's safe numeric range.");
		return number;
	},
	toDriver: (value) => {
		if (!Number.isSafeInteger(value)) throw new RangeError("Expected a safe integer for SQLite storage.");
		return BigInt(value);
	},
});

const timestamp = customType<{ data: Date; driverData: bigint }>({
	dataType: () => "INTEGER",
	toDriver: (value) => BigInt(value.getTime()),
	fromDriver: (value) => new Date(Number(value)),
});

/**
 * Completely separate public abuse-reporting aggregate. It intentionally has
 * no foreign keys to submissions, analysis_runs, or legacy report records.
 */
export const abuseReports = sqliteTable(
	"abuse_reports",
	{
		id: bignum("id").primaryKey(),
		trackingTokenHash: text("tracking_token_hash").notNull(),
		idempotencyKey: text("idempotency_key"),
		requestPayloadHash: text("request_payload_hash").notNull(),
		allegationCategory: text("allegation_category").notNull(),
		description: text("description").notNull(),
		legalBrandUrl: text("legal_brand_url"),
		reporterContactEmail: text("reporter_contact_email"),
		reporterIdentity: text("reporter_identity").notNull().default("service"),
		serviceIdentity: text("service_identity", { mode: "json" }).$type<Record<string, unknown>>(),
		verificationOutcome: text("verification_outcome", { mode: "json" }).$type<Record<string, unknown>>(),
		status: text("status", { enum: abuseReportStatuses }).notNull().default("accepted"),
		requesterIp: text("requester_ip"),
		requesterCountry: text("requester_country"),
		requesterHeaders: text("requester_headers", { mode: "json" }).$type<Record<string, string>>(),
		createdAt: timestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
		updatedAt: timestamp("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("abuse_reports_tracking_token_hash_unique").on(table.trackingTokenHash),
		uniqueIndex("abuse_reports_idempotency_key_unique").on(table.idempotencyKey),
		index("abuse_reports_status_updated_idx").on(table.status, table.updatedAt),
	]
);

/** One normalized target with every original occurrence retained in JSON provenance. */
export const abuseTargets = sqliteTable(
	"abuse_targets",
	{
		id: bignum("id").primaryKey(),
		reportId: bignum("report_id")
			.notNull()
			.references(() => abuseReports.id, { onDelete: "cascade" }),
		ordinal: integer("ordinal").notNull(),
		originalInput: text("original_input").notNull(),
		originalInputs: text("original_inputs", { mode: "json" }).$type<string[]>().notNull(),
		normalizedTarget: text("normalized_target").notNull(),
		targetType: text("target_type", { enum: abuseTargetTypes }).notNull(),
		observedUrls: text("observed_urls", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
		resolutionStatus: text("resolution_status", { enum: abuseTargetStatuses }).notNull().default("pending"),
		resolverSnapshot: text("resolver_snapshot", { mode: "json" }).$type<Record<string, unknown>>(),
		disposition: text("disposition"),
		createdAt: timestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
		updatedAt: timestamp("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
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
		id: bignum("id").primaryKey(),
		reportId: bignum("report_id")
			.notNull()
			.references(() => abuseReports.id, { onDelete: "cascade" }),
		targetId: bignum("target_id")
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
		verificationResult: text("verification_result", { mode: "json" }).$type<Record<string, unknown>>(),
		serviceIdentity: text("service_identity", { mode: "json" }).$type<Record<string, unknown>>(),
		status: text("status", { enum: abuseRouteStatuses }).notNull().default("resolving"),
		createdAt: timestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
		updatedAt: timestamp("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
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
		id: bignum("id").primaryKey(),
		reportId: bignum("report_id")
			.notNull()
			.references(() => abuseReports.id, { onDelete: "cascade" }),
		routeId: bignum("route_id")
			.notNull()
			.references(() => abuseProviderRoutes.id, { onDelete: "cascade" }),
		providerPayload: text("provider_payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
		payloadHash: text("payload_hash").notNull(),
		correlationKey: text("correlation_key").notNull(),
		skyvernRunId: text("skyvern_run_id"),
		attemptCount: integer("attempt_count").notNull().default(0),
		executionStatus: text("execution_status", { enum: abuseRunStatuses }).notNull().default("pending"),
		confirmationId: text("confirmation_id"),
		confirmationText: text("confirmation_text"),
		finalUrl: text("final_url"),
		submittedTargets: text("submitted_targets", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
		failureReason: text("failure_reason"),
		createdAt: timestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
		updatedAt: timestamp("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("abuse_provider_runs_correlation_key_unique").on(table.correlationKey),
		uniqueIndex("abuse_provider_runs_skyvern_run_unique").on(table.skyvernRunId),
		index("abuse_provider_runs_route_created_idx").on(table.routeId, table.createdAt),
		index("abuse_provider_runs_status_updated_idx").on(table.executionStatus, table.updatedAt),
	]
);

/** Permanent, report-owned content-addressed evidence and external artifacts. */
export const abuseArtifacts = sqliteTable(
	"abuse_artifacts",
	{
		id: bignum("id").primaryKey(),
		reportId: bignum("report_id")
			.notNull()
			.references(() => abuseReports.id, { onDelete: "cascade" }),
		targetId: bignum("target_id").references(() => abuseTargets.id, { onDelete: "set null" }),
		routeId: bignum("route_id").references(() => abuseProviderRoutes.id, { onDelete: "set null" }),
		runId: bignum("run_id").references(() => abuseProviderRuns.id, { onDelete: "set null" }),
		name: text("name").notNull(),
		kind: text("kind").notNull(),
		mimeType: text("mime_type").notNull(),
		sha256: text("sha256").notNull(),
		size: integer("size").notNull(),
		metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
		blob: blob("blob").notNull().$type<Buffer>(),
		createdAt: timestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
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
		id: bignum("id").primaryKey(),
		reportId: bignum("report_id")
			.notNull()
			.references(() => abuseReports.id, { onDelete: "cascade" }),
		routeId: bignum("route_id")
			.notNull()
			.references(() => abuseProviderRoutes.id, { onDelete: "cascade" }),
		runId: bignum("run_id").references(() => abuseProviderRuns.id, { onDelete: "set null" }),
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
		extractedLinks: text("extracted_links", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
		rawArtifactId: bignum("raw_artifact_id").references(() => abuseArtifacts.id, { onDelete: "set null" }),
		attachmentArtifactIds: text("attachment_artifact_ids", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
		imapMailbox: text("imap_mailbox"),
		imapUidValidity: integer("imap_uidvalidity"),
		imapUid: integer("imap_uid"),
		processingAttempts: integer("processing_attempts").notNull().default(0),
		disposition: text("disposition"),
		error: text("error"),
		occurredAt: timestamp("occurred_at").notNull(),
		createdAt: timestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
		updatedAt: timestamp("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("abuse_mail_messages_imap_uid_unique").on(table.imapMailbox, table.imapUidValidity, table.imapUid),
		index("abuse_mail_messages_route_occurred_idx").on(table.routeId, table.occurredAt),
		index("abuse_mail_messages_message_id_idx").on(table.messageId),
		index("abuse_mail_messages_reply_address_idx").on(table.replyAddress),
	]
);

/** Verification-code correlations retain a hash; complete source email stays in its raw artifact. */
export const abuseMailCodes = sqliteTable(
	"abuse_mail_codes",
	{
		id: bignum("id").primaryKey(),
		reportId: bignum("report_id")
			.notNull()
			.references(() => abuseReports.id, { onDelete: "cascade" }),
		routeId: bignum("route_id")
			.notNull()
			.references(() => abuseProviderRoutes.id, { onDelete: "cascade" }),
		runId: bignum("run_id").references(() => abuseProviderRuns.id, { onDelete: "set null" }),
		mailMessageId: bignum("mail_message_id").references(() => abuseMailMessages.id, { onDelete: "set null" }),
		codeHash: text("code_hash").notNull(),
		correlationKey: text("correlation_key"),
		status: text("status").notNull().default("received"),
		createdAt: timestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
		usedAt: timestamp("used_at"),
	},
	(table) => [
		index("abuse_mail_codes_route_status_idx").on(table.routeId, table.status, table.createdAt),
	]
);

/** Durable worker jobs. No process-local stream is used as execution state. */
export const abuseJobs = sqliteTable(
	"abuse_jobs",
	{
		id: bignum("id").primaryKey(),
		jobType: text("job_type", { enum: abuseJobTypes }).notNull(),
		reportId: bignum("report_id").references(() => abuseReports.id, { onDelete: "cascade" }),
		routeId: bignum("route_id").references(() => abuseProviderRoutes.id, { onDelete: "cascade" }),
		runId: bignum("run_id").references(() => abuseProviderRuns.id, { onDelete: "cascade" }),
		payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
		dedupeKey: text("dedupe_key"),
		status: text("status", { enum: abuseJobStatuses }).notNull().default("queued"),
		leaseOwner: text("lease_owner"),
		leaseExpiresAt: timestamp("lease_expires_at"),
		retryCount: integer("retry_count").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at").notNull(),
		unknownExternalState: int("unknown_external_state", { mode: "boolean" }).notNull().default(false),
		lastError: text("last_error"),
		createdAt: timestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
		updatedAt: timestamp("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		index("abuse_jobs_claim_idx").on(table.status, table.nextAttemptAt, table.leaseExpiresAt),
		index("abuse_jobs_route_status_idx").on(table.routeId, table.status),
		index("abuse_jobs_dedupe_idx").on(table.dedupeKey, table.status),
	]
);

/** Append-only audit trail. Events are never updated or deleted by the service. */
export const abuseEvents = sqliteTable(
	"abuse_events",
	{
		id: bignum("id").primaryKey(),
		reportId: bignum("report_id")
			.notNull()
			.references(() => abuseReports.id, { onDelete: "cascade" }),
		targetId: bignum("target_id").references(() => abuseTargets.id, { onDelete: "set null" }),
		routeId: bignum("route_id").references(() => abuseProviderRoutes.id, { onDelete: "set null" }),
		runId: bignum("run_id").references(() => abuseProviderRuns.id, { onDelete: "set null" }),
		jobId: bignum("job_id").references(() => abuseJobs.id, { onDelete: "set null" }),
		eventType: text("event_type").notNull(),
		data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
		createdAt: timestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		index("abuse_events_report_created_idx").on(table.reportId, table.createdAt),
		index("abuse_events_route_created_idx").on(table.routeId, table.createdAt),
	]
);

/** Persisted webhook ledger provides replay protection independently from the worker. */
export const abuseWebhookEvents = sqliteTable(
	"abuse_webhook_events",
	{
		id: bignum("id").primaryKey(),
		eventId: text("event_id").notNull(),
		skyvernRunId: text("skyvern_run_id"),
		timestamp: integer("timestamp").notNull(),
		payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
		payloadHash: text("payload_hash").notNull(),
		receivedAt: timestamp("received_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("abuse_webhook_events_event_id_unique").on(table.eventId),
		index("abuse_webhook_events_run_idx").on(table.skyvernRunId),
	]
);

/** Lease-backed singleton locks for provider-owned external resources. */
export const abuseLocks = sqliteTable(
	"abuse_locks",
	{
		lockKey: text("lock_key").primaryKey(),
		owner: text("owner").notNull(),
		leaseExpiresAt: timestamp("lease_expires_at").notNull(),
		updatedAt: timestamp("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
	},
	(table) => [index("abuse_locks_lease_idx").on(table.leaseExpiresAt)]
);

export type AbuseReport = InferSelectModel<typeof abuseReports>;
export type AbuseTarget = InferSelectModel<typeof abuseTargets>;
export type AbuseProviderRoute = InferSelectModel<typeof abuseProviderRoutes>;
export type AbuseProviderRun = InferSelectModel<typeof abuseProviderRuns>;
export type AbuseArtifact = InferSelectModel<typeof abuseArtifacts>;
export type AbuseMailMessage = InferSelectModel<typeof abuseMailMessages>;
export type AbuseMailCode = InferSelectModel<typeof abuseMailCodes>;
export type AbuseJob = InferSelectModel<typeof abuseJobs>;
export type AbuseEvent = InferSelectModel<typeof abuseEvents>;
