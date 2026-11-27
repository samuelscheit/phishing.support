-- Artifact bytes move out of SQLite into the content-addressed blob store
-- (src/lib/db/blobs.ts). getDb() copies every inline blob there before it runs
-- this migration (extractInlineBlobsBeforeMigration), and gives a row without
-- a hash or size those of its bytes; applied any other way, the bytes are lost.
-- Migrations run with foreign keys off, so the rebuild cascades nothing.
CREATE TABLE `__new_artifacts` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`submission_id` INTEGER,
	`name` text,
	`kind` text NOT NULL,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	`archived_at` INTEGER,
	`mime_type` text,
	`sha256` text NOT NULL,
	`size` INTEGER NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_artifacts`("id", "submission_id", "name", "kind", "created_at", "archived_at", "mime_type", "sha256", "size") SELECT "id", "submission_id", "name", "kind", "created_at", "archived_at", "mime_type", coalesce("sha256", ''), coalesce("size", 0) FROM `artifacts`;
--> statement-breakpoint
DROP TABLE `artifacts`;
--> statement-breakpoint
ALTER TABLE `__new_artifacts` RENAME TO `artifacts`;
--> statement-breakpoint
CREATE INDEX `artifacts_submission_kind_created_idx` ON `artifacts` (`submission_id`,`kind`,`created_at`);
--> statement-breakpoint
-- Keeps its indexes and foreign keys, and abuse_mail_messages' reference to it.
ALTER TABLE `abuse_artifacts` DROP COLUMN `blob`;
--> statement-breakpoint
ALTER TABLE `submissions` ADD `title` text;
--> statement-breakpoint
ALTER TABLE `submissions` ADD `reported_as` text;
--> statement-breakpoint
-- As submissionTitle and caseReportedAs (src/lib/submissions/finding.ts) set them from here on.
UPDATE `submissions` SET
	`title` = coalesce(nullif(json_extract(`data`, '$.website.url'), ''), nullif(json_extract(`data`, '$.email.subject'), ''), `dedupe_key`),
	`reported_as` = CASE WHEN `kind` = 'email' THEN 'phishing' ELSE (
		SELECT CASE
			WHEN found.phishing AND found.malware THEN 'phishing_and_malware'
			WHEN found.phishing THEN 'phishing'
			WHEN found.malware THEN 'malware'
			WHEN found.funnel THEN 'deceptive_funnel'
		END
		FROM (SELECT
			EXISTS (SELECT 1 FROM json_each(`submissions`.`data`, '$.website.routes') AS walked, json_each(walked.value, '$.siteAssessments') AS assessed WHERE json_extract(assessed.value, '$.finding') = 'phishing') AS phishing,
			EXISTS (SELECT 1 FROM json_each(`submissions`.`data`, '$.website.routes') AS walked, json_each(walked.value, '$.siteAssessments') AS assessed WHERE json_extract(assessed.value, '$.finding') = 'malware') AS malware,
			EXISTS (SELECT 1 FROM json_each(`submissions`.`data`, '$.website.routes') AS walked WHERE json_extract(walked.value, '$.funnel.verdict.finding') = 'deceptive_funnel') AS funnel
		) AS found
	) END;
--> statement-breakpoint
CREATE INDEX `submissions_list_covering_idx` ON `submissions` (`created_at`,`id`,`status`,`kind`,`site_group`,`title`,`reported_as`);
--> statement-breakpoint
CREATE INDEX `submissions_status_created_id_idx` ON `submissions` (`status`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `submissions_id_site_group_idx` ON `submissions` (`id`,`site_group`);
--> statement-breakpoint
CREATE INDEX `analysis_runs_submission_created_idx` ON `analysis_runs` (`submission_id`,`created_at`);
