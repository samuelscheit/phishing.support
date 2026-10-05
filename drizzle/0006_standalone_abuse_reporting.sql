CREATE TABLE `abuse_artifacts` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`report_id` INTEGER NOT NULL,
	`target_id` INTEGER,
	`route_id` INTEGER,
	`run_id` INTEGER,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`mime_type` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`metadata` text,
	`blob` blob NOT NULL,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `abuse_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `abuse_targets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`route_id`) REFERENCES `abuse_provider_routes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`run_id`) REFERENCES `abuse_provider_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `abuse_artifacts_report_sha_size_idx` ON `abuse_artifacts` (`report_id`,`sha256`,`size`);--> statement-breakpoint
CREATE INDEX `abuse_artifacts_report_kind_created_idx` ON `abuse_artifacts` (`report_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `abuse_artifacts_run_idx` ON `abuse_artifacts` (`run_id`);--> statement-breakpoint
CREATE TABLE `abuse_events` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`report_id` INTEGER NOT NULL,
	`target_id` INTEGER,
	`route_id` INTEGER,
	`run_id` INTEGER,
	`job_id` INTEGER,
	`event_type` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `abuse_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `abuse_targets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`route_id`) REFERENCES `abuse_provider_routes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`run_id`) REFERENCES `abuse_provider_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`job_id`) REFERENCES `abuse_jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `abuse_events_report_created_idx` ON `abuse_events` (`report_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `abuse_events_route_created_idx` ON `abuse_events` (`route_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `abuse_jobs` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`job_type` text NOT NULL,
	`report_id` INTEGER,
	`route_id` INTEGER,
	`run_id` INTEGER,
	`payload` text,
	`dedupe_key` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`lease_owner` text,
	`lease_expires_at` INTEGER,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` INTEGER NOT NULL,
	`unknown_external_state` integer DEFAULT false NOT NULL,
	`last_error` text,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `abuse_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`route_id`) REFERENCES `abuse_provider_routes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `abuse_provider_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `abuse_jobs_claim_idx` ON `abuse_jobs` (`status`,`next_attempt_at`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `abuse_jobs_route_status_idx` ON `abuse_jobs` (`route_id`,`status`);--> statement-breakpoint
CREATE INDEX `abuse_jobs_dedupe_idx` ON `abuse_jobs` (`dedupe_key`,`status`);--> statement-breakpoint
CREATE TABLE `abuse_locks` (
	`lock_key` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`lease_expires_at` INTEGER NOT NULL,
	`updated_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `abuse_locks_lease_idx` ON `abuse_locks` (`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `abuse_mail_codes` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`report_id` INTEGER NOT NULL,
	`route_id` INTEGER NOT NULL,
	`run_id` INTEGER,
	`mail_message_id` INTEGER,
	`code_hash` text NOT NULL,
	`correlation_key` text,
	`status` text DEFAULT 'received' NOT NULL,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	`used_at` INTEGER,
	FOREIGN KEY (`report_id`) REFERENCES `abuse_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`route_id`) REFERENCES `abuse_provider_routes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `abuse_provider_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`mail_message_id`) REFERENCES `abuse_mail_messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `abuse_mail_codes_route_status_idx` ON `abuse_mail_codes` (`route_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `abuse_mail_messages` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`report_id` INTEGER NOT NULL,
	`route_id` INTEGER NOT NULL,
	`run_id` INTEGER,
	`direction` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`from_address` text,
	`to_addresses` text DEFAULT '[]' NOT NULL,
	`subject` text,
	`text_body` text,
	`message_id` text,
	`in_reply_to` text,
	`references` text DEFAULT '[]' NOT NULL,
	`reply_address` text,
	`correlation_key` text,
	`classification` text,
	`extracted_links` text DEFAULT '[]' NOT NULL,
	`raw_artifact_id` INTEGER,
	`attachment_artifact_ids` text DEFAULT '[]' NOT NULL,
	`imap_mailbox` text,
	`imap_uidvalidity` integer,
	`imap_uid` integer,
	`processing_attempts` integer DEFAULT 0 NOT NULL,
	`disposition` text,
	`error` text,
	`occurred_at` INTEGER NOT NULL,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `abuse_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`route_id`) REFERENCES `abuse_provider_routes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `abuse_provider_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`raw_artifact_id`) REFERENCES `abuse_artifacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `abuse_mail_messages_imap_uid_unique` ON `abuse_mail_messages` (`imap_mailbox`,`imap_uidvalidity`,`imap_uid`);--> statement-breakpoint
CREATE INDEX `abuse_mail_messages_route_occurred_idx` ON `abuse_mail_messages` (`route_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `abuse_mail_messages_message_id_idx` ON `abuse_mail_messages` (`message_id`);--> statement-breakpoint
CREATE INDEX `abuse_mail_messages_reply_address_idx` ON `abuse_mail_messages` (`reply_address`);--> statement-breakpoint
CREATE TABLE `abuse_provider_routes` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`report_id` INTEGER NOT NULL,
	`target_id` INTEGER NOT NULL,
	`route_key` text NOT NULL,
	`provider_registry_key` text NOT NULL,
	`provider_display_name` text NOT NULL,
	`route_type` text NOT NULL,
	`verified_email` text,
	`provider_definition_version` text,
	`provider_definition_hash` text,
	`resolver_provenance` text NOT NULL,
	`resolution_snapshot` text NOT NULL,
	`verification_result` text,
	`service_identity` text,
	`status` text DEFAULT 'resolving' NOT NULL,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `abuse_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `abuse_targets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `abuse_provider_routes_target_route_key_unique` ON `abuse_provider_routes` (`target_id`,`route_key`);--> statement-breakpoint
CREATE INDEX `abuse_provider_routes_report_status_idx` ON `abuse_provider_routes` (`report_id`,`status`);--> statement-breakpoint
CREATE INDEX `abuse_provider_routes_target_idx` ON `abuse_provider_routes` (`target_id`);--> statement-breakpoint
CREATE TABLE `abuse_provider_runs` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`report_id` INTEGER NOT NULL,
	`route_id` INTEGER NOT NULL,
	`provider_payload` text NOT NULL,
	`payload_hash` text NOT NULL,
	`correlation_key` text NOT NULL,
	`skyvern_run_id` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`execution_status` text DEFAULT 'pending' NOT NULL,
	`confirmation_id` text,
	`confirmation_text` text,
	`final_url` text,
	`submitted_targets` text DEFAULT '[]' NOT NULL,
	`failure_reason` text,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `abuse_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`route_id`) REFERENCES `abuse_provider_routes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `abuse_provider_runs_correlation_key_unique` ON `abuse_provider_runs` (`correlation_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `abuse_provider_runs_skyvern_run_unique` ON `abuse_provider_runs` (`skyvern_run_id`);--> statement-breakpoint
CREATE INDEX `abuse_provider_runs_route_created_idx` ON `abuse_provider_runs` (`route_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `abuse_provider_runs_status_updated_idx` ON `abuse_provider_runs` (`execution_status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `abuse_reports` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`tracking_token_hash` text NOT NULL,
	`idempotency_key` text,
	`request_payload_hash` text NOT NULL,
	`allegation_category` text NOT NULL,
	`description` text NOT NULL,
	`legal_brand_url` text,
	`reporter_contact_email` text,
	`reporter_identity` text DEFAULT 'service' NOT NULL,
	`service_identity` text,
	`verification_outcome` text,
	`status` text DEFAULT 'accepted' NOT NULL,
	`requester_ip` text,
	`requester_country` text,
	`requester_headers` text,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `abuse_reports_tracking_token_hash_unique` ON `abuse_reports` (`tracking_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `abuse_reports_idempotency_key_unique` ON `abuse_reports` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `abuse_reports_status_updated_idx` ON `abuse_reports` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `abuse_targets` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`report_id` INTEGER NOT NULL,
	`ordinal` integer NOT NULL,
	`original_input` text NOT NULL,
	`original_inputs` text NOT NULL,
	`normalized_target` text NOT NULL,
	`target_type` text NOT NULL,
	`observed_urls` text DEFAULT '[]' NOT NULL,
	`resolution_status` text DEFAULT 'pending' NOT NULL,
	`resolver_snapshot` text,
	`disposition` text,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `abuse_reports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `abuse_targets_report_normalized_unique` ON `abuse_targets` (`report_id`,`normalized_target`);--> statement-breakpoint
CREATE INDEX `abuse_targets_report_ordinal_idx` ON `abuse_targets` (`report_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `abuse_webhook_events` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`skyvern_run_id` text,
	`timestamp` integer NOT NULL,
	`payload` text NOT NULL,
	`payload_hash` text NOT NULL,
	`received_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `abuse_webhook_events_event_id_unique` ON `abuse_webhook_events` (`event_id`);--> statement-breakpoint
CREATE INDEX `abuse_webhook_events_run_idx` ON `abuse_webhook_events` (`skyvern_run_id`);
