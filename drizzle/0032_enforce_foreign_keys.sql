-- Connections now enforce foreign keys (src/lib/db/index.ts). Until now none
-- did, so deletes left children behind and 0016's hand-written column lost the
-- schema's ON DELETE cascade. Rebuild abuse_reports with it, then settle every
-- orphan as its foreign key's ON DELETE would have, parents before children.
-- Migrations run with foreign keys off, so the rebuild cascades nothing.
-- A NULL column refers to nothing, yet `NULL NOT IN (<empty set>)` is true:
-- nullable columns are tested for NOT NULL first.
CREATE TABLE `__new_abuse_reports` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`submission_id` INTEGER,
	`campaign_id` INTEGER,
	`tracking_token_hash` text NOT NULL,
	`idempotency_key` text,
	`request_payload_hash` text NOT NULL,
	`allegation_category` text NOT NULL,
	`description` text NOT NULL,
	`legal_brand_url` text,
	`reported_user_agent` text,
	`reporter_name` text,
	`reporter_contact_email` text,
	`status` text DEFAULT 'accepted' NOT NULL,
	`requester_ip` text,
	`requester_country` text,
	`requester_headers` text,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_abuse_reports`("id", "submission_id", "campaign_id", "tracking_token_hash", "idempotency_key", "request_payload_hash", "allegation_category", "description", "legal_brand_url", "reported_user_agent", "reporter_name", "reporter_contact_email", "status", "requester_ip", "requester_country", "requester_headers", "created_at", "updated_at")
SELECT "id", "submission_id", "campaign_id", "tracking_token_hash", "idempotency_key", "request_payload_hash", "allegation_category", "description", "legal_brand_url", "reported_user_agent", "reporter_name", "reporter_contact_email", "status", "requester_ip", "requester_country", "requester_headers", "created_at", "updated_at" FROM `abuse_reports`;
--> statement-breakpoint
DROP TABLE `abuse_reports`;
--> statement-breakpoint
ALTER TABLE `__new_abuse_reports` RENAME TO `abuse_reports`;
--> statement-breakpoint
CREATE UNIQUE INDEX `abuse_reports_tracking_token_hash_unique` ON `abuse_reports` (`tracking_token_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `abuse_reports_idempotency_key_unique` ON `abuse_reports` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `abuse_reports_submission_idx` ON `abuse_reports` (`submission_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `abuse_reports_campaign_unique` ON `abuse_reports` (`campaign_id`);
--> statement-breakpoint
CREATE INDEX `abuse_reports_status_updated_idx` ON `abuse_reports` (`status`,`updated_at`);
--> statement-breakpoint
DELETE FROM `analysis_runs` WHERE `submission_id` NOT IN (SELECT `id` FROM `submissions`);
--> statement-breakpoint
DELETE FROM `artifacts` WHERE `submission_id` IS NOT NULL AND `submission_id` NOT IN (SELECT `id` FROM `submissions`);
--> statement-breakpoint
DELETE FROM `submission_retries` WHERE `submission_id` NOT IN (SELECT `id` FROM `submissions`);
--> statement-breakpoint
DELETE FROM `abuse_reports` WHERE (`submission_id` IS NOT NULL AND `submission_id` NOT IN (SELECT `id` FROM `submissions`)) OR (`campaign_id` IS NOT NULL AND `campaign_id` NOT IN (SELECT `id` FROM `campaigns`));
--> statement-breakpoint
DELETE FROM `abuse_report_cases` WHERE `report_id` NOT IN (SELECT `id` FROM `abuse_reports`) OR `submission_id` NOT IN (SELECT `id` FROM `submissions`);
--> statement-breakpoint
DELETE FROM `campaign_members` WHERE `campaign_id` NOT IN (SELECT `id` FROM `campaigns`) OR `report_id` NOT IN (SELECT `id` FROM `abuse_reports`) OR `submission_id` NOT IN (SELECT `id` FROM `submissions`);
--> statement-breakpoint
DELETE FROM `campaign_site_facts` WHERE `report_id` NOT IN (SELECT `id` FROM `abuse_reports`) OR `submission_id` NOT IN (SELECT `id` FROM `submissions`);
--> statement-breakpoint
DELETE FROM `campaign_indicators` WHERE `report_id` NOT IN (SELECT `id` FROM `abuse_reports`) OR `submission_id` NOT IN (SELECT `id` FROM `submissions`);
--> statement-breakpoint
DELETE FROM `abuse_targets` WHERE `report_id` NOT IN (SELECT `id` FROM `abuse_reports`);
--> statement-breakpoint
DELETE FROM `site_checks` WHERE `report_id` NOT IN (SELECT `id` FROM `abuse_reports`) OR `target_id` NOT IN (SELECT `id` FROM `abuse_targets`);
--> statement-breakpoint
DELETE FROM `abuse_provider_routes` WHERE `report_id` NOT IN (SELECT `id` FROM `abuse_reports`) OR `target_id` NOT IN (SELECT `id` FROM `abuse_targets`);
--> statement-breakpoint
DELETE FROM `abuse_provider_runs` WHERE `report_id` NOT IN (SELECT `id` FROM `abuse_reports`) OR `route_id` NOT IN (SELECT `id` FROM `abuse_provider_routes`);
--> statement-breakpoint
DELETE FROM `abuse_jobs` WHERE (`report_id` IS NOT NULL AND `report_id` NOT IN (SELECT `id` FROM `abuse_reports`)) OR (`route_id` IS NOT NULL AND `route_id` NOT IN (SELECT `id` FROM `abuse_provider_routes`)) OR (`run_id` IS NOT NULL AND `run_id` NOT IN (SELECT `id` FROM `abuse_provider_runs`));
--> statement-breakpoint
DELETE FROM `abuse_artifacts` WHERE `report_id` NOT IN (SELECT `id` FROM `abuse_reports`);
--> statement-breakpoint
UPDATE `abuse_artifacts` SET `target_id` = NULL WHERE `target_id` NOT IN (SELECT `id` FROM `abuse_targets`);
--> statement-breakpoint
UPDATE `abuse_artifacts` SET `route_id` = NULL WHERE `route_id` NOT IN (SELECT `id` FROM `abuse_provider_routes`);
--> statement-breakpoint
UPDATE `abuse_artifacts` SET `run_id` = NULL WHERE `run_id` NOT IN (SELECT `id` FROM `abuse_provider_runs`);
--> statement-breakpoint
DELETE FROM `abuse_mail_messages` WHERE `report_id` NOT IN (SELECT `id` FROM `abuse_reports`) OR `route_id` NOT IN (SELECT `id` FROM `abuse_provider_routes`);
--> statement-breakpoint
UPDATE `abuse_mail_messages` SET `run_id` = NULL WHERE `run_id` NOT IN (SELECT `id` FROM `abuse_provider_runs`);
--> statement-breakpoint
UPDATE `abuse_mail_messages` SET `raw_artifact_id` = NULL WHERE `raw_artifact_id` NOT IN (SELECT `id` FROM `abuse_artifacts`);
--> statement-breakpoint
DELETE FROM `abuse_events` WHERE `report_id` NOT IN (SELECT `id` FROM `abuse_reports`);
--> statement-breakpoint
UPDATE `abuse_events` SET `target_id` = NULL WHERE `target_id` NOT IN (SELECT `id` FROM `abuse_targets`);
--> statement-breakpoint
UPDATE `abuse_events` SET `route_id` = NULL WHERE `route_id` NOT IN (SELECT `id` FROM `abuse_provider_routes`);
--> statement-breakpoint
UPDATE `abuse_events` SET `run_id` = NULL WHERE `run_id` NOT IN (SELECT `id` FROM `abuse_provider_runs`);
--> statement-breakpoint
UPDATE `abuse_events` SET `job_id` = NULL WHERE `job_id` NOT IN (SELECT `id` FROM `abuse_jobs`);
