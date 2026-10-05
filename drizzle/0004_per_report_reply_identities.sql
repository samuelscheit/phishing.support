CREATE TABLE `mail_ingest` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`mailbox` text NOT NULL,
	`uid_validity` integer NOT NULL,
	`uid` integer NOT NULL,
	`message_id` text,
	`route` text NOT NULL,
	`report_message_id` INTEGER,
	`reason` text,
	`attempts` integer DEFAULT 1 NOT NULL,
	`terminal` integer DEFAULT true NOT NULL,
	`processed_at` INTEGER NOT NULL,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`report_message_id`) REFERENCES `report_messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_ingest_mailbox_uid_unique` ON `mail_ingest` (`mailbox`,`uid_validity`,`uid`);--> statement-breakpoint
CREATE INDEX `mail_ingest_message_id_idx` ON `mail_ingest` (`message_id`);--> statement-breakpoint
CREATE INDEX `mail_ingest_route_processed_idx` ON `mail_ingest` (`route`,`processed_at`);--> statement-breakpoint
CREATE TABLE `provider_reports` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`submission_id` INTEGER NOT NULL,
	`analysis_run_id` INTEGER,
	`channel` text DEFAULT 'provider' NOT NULL,
	`to` text NOT NULL,
	`subject` text,
	`body` text NOT NULL,
	`status` text DEFAULT 'sent' NOT NULL,
	`sent_at` INTEGER,
	`provider_message_id` text,
	`attachments_artifact_ids` text,
	`data` text,
	`legacy` integer DEFAULT false NOT NULL,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`analysis_run_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `provider_reports_submission_created_idx` ON `provider_reports` (`submission_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `provider_reports_to_created_idx` ON `provider_reports` (`to`,`created_at`);--> statement-breakpoint
CREATE INDEX `provider_reports_status_created_idx` ON `provider_reports` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `report_messages` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`thread_id` INTEGER NOT NULL,
	`direction` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`from` text,
	`to` text NOT NULL,
	`cc` text DEFAULT '[]' NOT NULL,
	`subject` text,
	`text_body` text,
	`html_body` text,
	`message_id` text,
	`in_reply_to` text,
	`references` text DEFAULT '[]' NOT NULL,
	`provider_message_id` text,
	`raw_artifact_id` INTEGER,
	`attachment_artifact_ids` text DEFAULT '[]' NOT NULL,
	`occurred_at` INTEGER NOT NULL,
	`sent_at` INTEGER,
	`error` text,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `report_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`raw_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `report_messages_thread_occurred_idx` ON `report_messages` (`thread_id`,`occurred_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `report_messages_thread_message_id_unique` ON `report_messages` (`thread_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `report_messages_message_id_idx` ON `report_messages` (`message_id`);--> statement-breakpoint
CREATE INDEX `report_messages_in_reply_to_idx` ON `report_messages` (`in_reply_to`);--> statement-breakpoint
CREATE TABLE `report_threads` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`submission_id` INTEGER NOT NULL,
	`analysis_run_id` INTEGER,
	`to` text NOT NULL,
	`subject` text,
	`reply_address` text NOT NULL,
	`reply_token` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`data` text,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`analysis_run_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_threads_reply_address_unique` ON `report_threads` (`reply_address`);--> statement-breakpoint
CREATE UNIQUE INDEX `report_threads_reply_token_unique` ON `report_threads` (`reply_token`);--> statement-breakpoint
CREATE INDEX `report_threads_submission_created_idx` ON `report_threads` (`submission_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `report_threads_status_updated_idx` ON `report_threads` (`status`,`updated_at`);--> statement-breakpoint
/* Preserve the pre-correspondence report history as provider/legacy entries.
   Historical SMTP rows have no generated identity, so they intentionally do
   not become report_threads or report_messages. */
INSERT INTO `provider_reports` (
	`id`,
	`submission_id`,
	`analysis_run_id`,
	`channel`,
	`to`,
	`subject`,
	`body`,
	`status`,
	`sent_at`,
	`provider_message_id`,
	`attachments_artifact_ids`,
	`data`,
	`legacy`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`submission_id`,
	`analysis_run_id`,
	`channel`,
	`to`,
	`subject`,
	`body`,
	`status`,
	`sent_at`,
	`provider_message_id`,
	`attachments_artifact_ids`,
	`data`,
	1,
	`created_at`,
	`updated_at`
FROM `reports`;--> statement-breakpoint
DROP TABLE `reports`;
