-- The worker's queue now also runs website visits, which belong to no abuse
-- report: the table is `jobs`. The migrator's connection does not rewrite the
-- foreign keys that name a renamed table, so abuse_events is rebuilt with its
-- job_id pointing at `jobs`; the indexes keep their old names on RENAME, so
-- they are recreated under the new one.
ALTER TABLE `abuse_jobs` RENAME TO `jobs`;--> statement-breakpoint
DROP INDEX `abuse_jobs_claim_idx`;--> statement-breakpoint
DROP INDEX `abuse_jobs_route_status_idx`;--> statement-breakpoint
DROP INDEX `abuse_jobs_dedupe_idx`;--> statement-breakpoint
ALTER TABLE `jobs` ADD `fair_key` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `serial_key` text;--> statement-breakpoint
-- One running job per provider route, as before, now through the serial key.
UPDATE `jobs` SET `serial_key` = 'route:' || `route_id` WHERE `route_id` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,`next_attempt_at`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `jobs_route_status_idx` ON `jobs` (`route_id`,`status`);--> statement-breakpoint
CREATE INDEX `jobs_dedupe_idx` ON `jobs` (`dedupe_key`,`status`);--> statement-breakpoint
CREATE INDEX `jobs_serial_status_idx` ON `jobs` (`serial_key`,`status`);--> statement-breakpoint
CREATE INDEX `jobs_type_fair_status_idx` ON `jobs` (`job_type`,`fair_key`,`status`);--> statement-breakpoint
CREATE TABLE `__new_abuse_events` (
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
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_abuse_events`("id", "report_id", "target_id", "route_id", "run_id", "job_id", "event_type", "data", "created_at") SELECT "id", "report_id", "target_id", "route_id", "run_id", "job_id", "event_type", "data", "created_at" FROM `abuse_events`;--> statement-breakpoint
DROP TABLE `abuse_events`;--> statement-breakpoint
ALTER TABLE `__new_abuse_events` RENAME TO `abuse_events`;--> statement-breakpoint
CREATE INDEX `abuse_events_report_created_idx` ON `abuse_events` (`report_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `abuse_events_route_created_idx` ON `abuse_events` (`route_id`,`created_at`);
