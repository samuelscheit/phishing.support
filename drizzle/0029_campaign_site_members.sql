-- A campaign member is one confirmed site as one case saw it: the case and the site's primary report (the case's own,
-- or another case's it joined). Until now a member was a case, and every case had one primary report: each existing
-- row becomes the member of that report, so every campaign keeps its sites and its id. A row of a case without a
-- primary report named no reported site and is dropped; the next link of the case's sites records them anew.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_campaign_members` (
	`submission_id` INTEGER NOT NULL,
	`report_id` INTEGER NOT NULL,
	`campaign_id` INTEGER NOT NULL,
	`joined_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`submission_id`, `report_id`),
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`report_id`) REFERENCES `abuse_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_campaign_members`("submission_id", "report_id", "campaign_id", "joined_at")
SELECT `submission_id`, `report_id`, `campaign_id`, `joined_at` FROM (
	SELECT `m`.*, (SELECT `r`.`id` FROM `abuse_reports` `r` WHERE `r`.`submission_id` = `m`.`submission_id` AND `r`.`idempotency_key` IS NULL ORDER BY `r`.`created_at`, `r`.`id` LIMIT 1) AS `report_id`
	FROM `campaign_members` `m`
) WHERE `report_id` IS NOT NULL;--> statement-breakpoint
DROP TABLE `campaign_members`;--> statement-breakpoint
ALTER TABLE `__new_campaign_members` RENAME TO `campaign_members`;--> statement-breakpoint
CREATE INDEX `campaign_members_campaign_idx` ON `campaign_members` (`campaign_id`,`joined_at`);--> statement-breakpoint
CREATE TABLE `__new_campaign_site_facts` (
	`submission_id` INTEGER NOT NULL,
	`report_id` INTEGER NOT NULL,
	`language` text,
	`thumbnail_artifact_id` INTEGER,
	`blank_capture` integer DEFAULT false NOT NULL,
	`updated_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`submission_id`, `report_id`),
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`report_id`) REFERENCES `abuse_reports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_campaign_site_facts`("submission_id", "report_id", "language", "thumbnail_artifact_id", "blank_capture", "updated_at")
SELECT `submission_id`, `report_id`, `language`, `thumbnail_artifact_id`, `blank_capture`, `updated_at` FROM (
	SELECT `f`.*, (SELECT `r`.`id` FROM `abuse_reports` `r` WHERE `r`.`submission_id` = `f`.`submission_id` AND `r`.`idempotency_key` IS NULL ORDER BY `r`.`created_at`, `r`.`id` LIMIT 1) AS `report_id`
	FROM `campaign_site_facts` `f`
) WHERE `report_id` IS NOT NULL;--> statement-breakpoint
DROP TABLE `campaign_site_facts`;--> statement-breakpoint
ALTER TABLE `__new_campaign_site_facts` RENAME TO `campaign_site_facts`;--> statement-breakpoint
CREATE TABLE `__new_campaign_indicators` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`submission_id` INTEGER NOT NULL,
	`report_id` INTEGER NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`links` integer NOT NULL,
	`evidence` text NOT NULL,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`report_id`) REFERENCES `abuse_reports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_campaign_indicators`("id", "submission_id", "report_id", "kind", "value", "links", "evidence", "created_at")
SELECT `id`, `submission_id`, `report_id`, `kind`, `value`, `links`, `evidence`, `created_at` FROM (
	SELECT `i`.*, (SELECT `r`.`id` FROM `abuse_reports` `r` WHERE `r`.`submission_id` = `i`.`submission_id` AND `r`.`idempotency_key` IS NULL ORDER BY `r`.`created_at`, `r`.`id` LIMIT 1) AS `report_id`
	FROM `campaign_indicators` `i`
) WHERE `report_id` IS NOT NULL;--> statement-breakpoint
DROP TABLE `campaign_indicators`;--> statement-breakpoint
ALTER TABLE `__new_campaign_indicators` RENAME TO `campaign_indicators`;--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_indicators_member_kind_value_unique` ON `campaign_indicators` (`submission_id`,`report_id`,`kind`,`value`);--> statement-breakpoint
CREATE INDEX `campaign_indicators_kind_value_idx` ON `campaign_indicators` (`kind`,`value`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
