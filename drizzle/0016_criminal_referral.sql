CREATE TABLE `campaign_indicators` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`submission_id` INTEGER NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`links` integer NOT NULL,
	`evidence` text NOT NULL,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_indicators_submission_kind_value_unique` ON `campaign_indicators` (`submission_id`,`kind`,`value`);--> statement-breakpoint
CREATE INDEX `campaign_indicators_kind_value_idx` ON `campaign_indicators` (`kind`,`value`);--> statement-breakpoint
CREATE TABLE `campaign_members` (
	`submission_id` INTEGER PRIMARY KEY NOT NULL,
	`campaign_id` INTEGER NOT NULL,
	`joined_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `campaign_members_campaign_idx` ON `campaign_members` (`campaign_id`,`joined_at`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`merged_into` INTEGER,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `campaigns_merged_into_idx` ON `campaigns` (`merged_into`);--> statement-breakpoint
CREATE TABLE `kit_hash_checks` (
	`sha256` text PRIMARY KEY NOT NULL,
	`library` text,
	`checked_at` INTEGER NOT NULL
);
--> statement-breakpoint
ALTER TABLE `abuse_provider_routes` ADD `case_reference` text;--> statement-breakpoint
ALTER TABLE `abuse_reports` ADD `campaign_id` INTEGER REFERENCES campaigns(id);--> statement-breakpoint
CREATE UNIQUE INDEX `abuse_reports_campaign_unique` ON `abuse_reports` (`campaign_id`);