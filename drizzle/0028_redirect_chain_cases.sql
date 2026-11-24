-- A website case owns its whole redirect chain; the per-site hand-off is gone. Data conversions first, so no reader of
-- the old shapes is left when the code that read them is gone. JSON is only read from rows a MATERIALIZED step found
-- valid: SQLite does not promise to test `json_valid` before another term of the same WHERE, and one malformed row
-- would make json_each or json_extract fail the whole migration.

-- Cases that confirmed a site another case's open report already covers join that report instead of a second one.
-- Created first: the hand-offs below join their destination's report through it.
CREATE TABLE `abuse_report_cases` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`report_id` INTEGER NOT NULL,
	`submission_id` INTEGER NOT NULL,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `abuse_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `abuse_report_cases_report_submission_unique` ON `abuse_report_cases` (`report_id`,`submission_id`);--> statement-breakpoint
CREATE INDEX `abuse_report_cases_submission_idx` ON `abuse_report_cases` (`submission_id`);--> statement-breakpoint

-- A case that handed its capture to another site's case takes the outcome of the case its chain of hand-offs ended in
-- (a destination could hand off again: A → B → C). Only a verdict counts: a chain that ends in a gone case, a case
-- still running, a case naming no destination, or loops (A → B → A) or runs longer than 20 hand-offs, ends in none.
CREATE TEMP TABLE `hand_off_outcomes` AS
WITH RECURSIVE `hand_offs`(`id`, `destination`) AS MATERIALIZED (
	SELECT `id`, CAST(json_extract(`data`, '$.website.redirectSubmissionId') AS INTEGER) FROM `submissions`
	WHERE `status` = 'redirected' AND json_valid(`data`)
), `walk`(`id`, `at`, `depth`) AS (
	SELECT `id`, `destination`, 1 FROM `hand_offs`
	UNION ALL
	SELECT `walk`.`id`, `next`.`destination`, `walk`.`depth` + 1 FROM `walk`
	INNER JOIN `hand_offs` `next` ON `next`.`id` = `walk`.`at`
	WHERE `walk`.`depth` < 20
)
SELECT `walk`.`id`, `final`.`id` AS `final_id`, `final`.`status` AS `status` FROM `walk`
LEFT JOIN `submissions` `final` ON `final`.`id` = `walk`.`at` AND `final`.`status` IN ('reported', 'failed', 'invalid')
WHERE NOT EXISTS (SELECT 1 FROM `walk` `deeper` WHERE `deeper`.`id` = `walk`.`id` AND `deeper`.`depth` > `walk`.`depth`);--> statement-breakpoint

-- A hand-off whose chain ended in a reported case joins that case's own reports (not the follow-ups it filed for
-- other sites), so the case shows the report about its destination. Every id the app generates is a snowflake, at
-- least 2^22 (the milliseconds since 2024 shifted past 22 bits), and the table is new: ids counted from 1 meet none.
INSERT INTO `abuse_report_cases` (`id`, `report_id`, `submission_id`)
SELECT ROW_NUMBER() OVER (ORDER BY `outcome`.`id`, `report`.`id`), `report`.`id`, `outcome`.`id` FROM `hand_off_outcomes` `outcome`
INNER JOIN `abuse_reports` `report` ON `report`.`submission_id` = `outcome`.`final_id` AND `report`.`idempotency_key` IS NULL
WHERE `outcome`.`status` = 'reported';--> statement-breakpoint

-- The case takes that verdict, its info kept and the case that reached it named; one without a verdict to take
-- (its data unreadable too) has none of its own.
UPDATE `submissions` SET
	`status` = COALESCE((SELECT `status` FROM `hand_off_outcomes` `outcome` WHERE `outcome`.`id` = `submissions`.`id`), 'invalid'),
	`info` = NULLIF(trim(COALESCE(`info`, '') || COALESCE((SELECT ' Its destination was analyzed in case ' || `final_id` || '.'
		FROM `hand_off_outcomes` `outcome` WHERE `outcome`.`id` = `submissions`.`id`), '')), '')
WHERE `status` = 'redirected';--> statement-breakpoint

DROP TABLE `hand_off_outcomes`;--> statement-breakpoint

-- The page a case's verdict rests on is named by its hop: until now, always the first captured page of its chain.
-- A hop is read through the case's own data by its path, so a hop that is no object reads as nothing.
WITH `websites` AS MATERIALIZED (
	SELECT `id`, `data` FROM `submissions` WHERE `kind` = 'website' AND json_valid(`data`)
), `analyzed`(`id`, `hop_index`) AS MATERIALIZED (
	SELECT `websites`.`id`, (
		SELECT json_extract(`websites`.`data`, `h`.`fullkey` || '.index') FROM json_each(`websites`.`data`, '$.website.navigationHops') `h`
		WHERE json_extract(`websites`.`data`, `h`.`fullkey` || '.contentCaptured') = 1 ORDER BY `h`.`id` LIMIT 1)
	FROM `websites` WHERE json_type(`websites`.`data`, '$.website.navigationHops') = 'array'
)
UPDATE `submissions` SET `data` = json_set(`data`, '$.website.analyzedHopIndex', (SELECT `hop_index` FROM `analyzed` WHERE `analyzed`.`id` = `submissions`.`id`))
WHERE `id` IN (SELECT `id` FROM `analyzed` WHERE `hop_index` IS NOT NULL);--> statement-breakpoint

-- The hand-off link and the pages listed after the judged one: every page of a chain is a hop of it now.
WITH `websites` AS MATERIALIZED (
	SELECT `id`, `data` FROM `submissions` WHERE `kind` = 'website' AND json_valid(`data`)
)
UPDATE `submissions` SET `data` = json_remove(`data`, '$.website.redirectSubmissionId', '$.website.laterPages')
WHERE `id` IN (SELECT `websites`.`id` FROM `websites`
	WHERE json_type(`websites`.`data`, '$.website.redirectSubmissionId') IS NOT NULL OR json_type(`websites`.`data`, '$.website.laterPages') IS NOT NULL);--> statement-breakpoint

-- A destination case a hand-off opened named its origin as `redirect:<id>`. It takes the source of the case its
-- lineage started from instead (a kit sibling's destination stays a sibling, an original report's stays original);
-- one whose origin is gone was submitted by no one else.
WITH RECURSIVE `lineage`(`id`, `ancestor_source`, `depth`) AS (
	SELECT `id`, `source`, 0 FROM `submissions` WHERE `source` LIKE 'redirect:%'
	UNION ALL
	SELECT `lineage`.`id`, `parent`.`source`, `lineage`.`depth` + 1 FROM `lineage`
	INNER JOIN `submissions` `parent` ON `parent`.`id` = CAST(substr(`lineage`.`ancestor_source`, 10) AS INTEGER)
	WHERE `lineage`.`ancestor_source` LIKE 'redirect:%' AND `lineage`.`depth` < 20
)
UPDATE `submissions` SET `source` = (
	SELECT `ancestor_source` FROM `lineage`
	WHERE `lineage`.`id` = `submissions`.`id` AND (`ancestor_source` IS NULL OR `ancestor_source` NOT LIKE 'redirect:%'))
WHERE `source` LIKE 'redirect:%';
