-- A website case owns its whole redirect chain; the per-site hand-off is gone. Data conversions first, so no reader of
-- the old shapes is left when the code that read them is gone.

-- A case that handed its capture to another site's case becomes a case with no verdict of its own, its info kept and
-- the destination's case named in it.
UPDATE `submissions` SET
	`status` = 'invalid',
	`info` = NULLIF(trim(COALESCE(`info`, '') || CASE WHEN json_valid(`data`) AND json_extract(`data`, '$.website.redirectSubmissionId') IS NOT NULL
		THEN ' Its destination was analyzed in case ' || json_extract(`data`, '$.website.redirectSubmissionId') || '.' ELSE '' END), '')
WHERE `status` = 'redirected';--> statement-breakpoint

-- The page a case's verdict rests on is named by its hop: until now, always the captured page the chain ended on.
UPDATE `submissions` SET `data` = json_set(`data`, '$.website.analyzedHopIndex', (
	SELECT json_extract(`h`.`value`, '$.index') FROM json_each(`submissions`.`data`, '$.website.navigationHops') `h`
	WHERE json_extract(`h`.`value`, '$.contentCaptured') = 1 LIMIT 1))
WHERE `kind` = 'website' AND json_valid(`data`) AND json_type(`data`, '$.website.navigationHops') = 'array'
	AND EXISTS (SELECT 1 FROM json_each(`submissions`.`data`, '$.website.navigationHops') `h` WHERE json_extract(`h`.`value`, '$.contentCaptured') = 1);--> statement-breakpoint

-- The hand-off link and the pages listed after the judged one: every page of a chain is a hop of it now.
UPDATE `submissions` SET `data` = json_remove(`data`, '$.website.redirectSubmissionId', '$.website.laterPages')
WHERE `kind` = 'website' AND json_valid(`data`)
	AND (json_type(`data`, '$.website.redirectSubmissionId') IS NOT NULL OR json_type(`data`, '$.website.laterPages') IS NOT NULL);--> statement-breakpoint

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
WHERE `source` LIKE 'redirect:%';--> statement-breakpoint

-- Cases that confirmed a site another case's open report already covers join that report instead of a second one.
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
CREATE INDEX `abuse_report_cases_submission_idx` ON `abuse_report_cases` (`submission_id`);