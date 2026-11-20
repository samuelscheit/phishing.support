-- Data conversions first, so no reader of the old shapes is left when the code that read them is gone.

-- Removed features: Skyvern reconciliation, kit sibling discovery, and events no code emits any more.
DELETE FROM `abuse_jobs` WHERE `job_type` IN ('reconcile_skyvern_run', 'discover_kit_siblings');--> statement-breakpoint
DELETE FROM `abuse_artifacts` WHERE `kind` = 'skyvern_extracted_output';--> statement-breakpoint
DELETE FROM `abuse_events` WHERE `event_type` LIKE 'provider_run.skyvern_%' OR `event_type` IN ('provider_run.draft_refanged', 'report.evidence_rewritten', 'route.operator_reset', 'provider_run.reconciled_failure');--> statement-breakpoint
DELETE FROM `artifacts` WHERE `kind` IN ('website_html', 'website_text', 'mail_png');--> statement-breakpoint

-- Routes recorded by the first report importer carried a `historical:` registry-key prefix.
UPDATE `abuse_provider_routes` SET `provider_registry_key` = substr(`provider_registry_key`, 12) WHERE `provider_registry_key` LIKE 'historical:%';--> statement-breakpoint

-- Two one-off operator rows named resolver sources nothing emits; both are network (RIR) contacts.
UPDATE `abuse_provider_routes` SET `resolver_provenance` = json_set(`resolver_provenance`, '$.source', 'ip_rdap') WHERE json_extract(`resolver_provenance`, '$.source') IN ('ripe_abuse_c', 'manual_backfill');--> statement-breakpoint

-- Imported refusals without any history: record that the route was filed when it was created, so the
-- provider statistics count it as delivered and rejected instead of special-casing a route with no events.
INSERT INTO `abuse_events` (`id`, `report_id`, `target_id`, `route_id`, `event_type`, `data`, `created_at`)
SELECT (SELECT COALESCE(MAX(`id`), 0) FROM `abuse_events`) + row_number() OVER (ORDER BY `r`.`id`), `r`.`report_id`, `r`.`target_id`, `r`.`id`, 'route.status_changed',
	json_object('from', 'resolving', 'to', 'submitted', 'backfilled', json('true')), `r`.`created_at`
FROM `abuse_provider_routes` `r`
WHERE `r`.`status` = 'provider_rejected'
	AND NOT EXISTS (SELECT 1 FROM `abuse_events` `e` WHERE `e`.`route_id` = `r`.`id` AND `e`.`event_type` = 'route.status_changed');--> statement-breakpoint

-- Analysis runs written before the explicit kind: a classifier or report draft is recognised by its
-- system prompt or its strict JSON output, anything else is the analysis shown to people.
UPDATE `analysis_runs` SET `analysis_kind` = 'classification' WHERE `analysis_kind` = 'report_draft';--> statement-breakpoint
CREATE TEMP TABLE `_analysis_run_texts` AS
SELECT `id`,
	(SELECT trim(CASE json_type(`j`.`value`, '$.content')
			WHEN 'text' THEN json_extract(`j`.`value`, '$.content')
			WHEN 'array' THEN COALESCE((SELECT group_concat(CASE WHEN json_type(`p`.`value`, '$.text') = 'text' THEN json_extract(`p`.`value`, '$.text') ELSE '' END, ' ') FROM json_each(`j`.`value`, '$.content') `p`), '')
			ELSE '' END)
		FROM json_each(CASE WHEN json_valid(`analysis_runs`.`input`) THEN `analysis_runs`.`input` ELSE '[]' END) `j`
		WHERE json_extract(`j`.`value`, '$.role') = 'system' LIMIT 1) AS `prompt`,
	(SELECT trim(COALESCE(group_concat(CASE json_extract(`c`.`value`, '$.type')
			WHEN 'output_text' THEN COALESCE(json_extract(`c`.`value`, '$.text'), '')
			WHEN 'refusal' THEN COALESCE(json_extract(`c`.`value`, '$.refusal'), 'Refusal')
			ELSE '' END, ''), ''))
		FROM json_each(CASE WHEN json_valid(`analysis_runs`.`output`) THEN `analysis_runs`.`output` ELSE '[]' END) `item`, json_each(`item`.`value`, '$.content') `c`
		WHERE json_extract(`item`.`value`, '$.type') = 'message' AND json_type(`item`.`value`, '$.content') = 'array') AS `text`
FROM `analysis_runs` WHERE `analysis_kind` = 'unknown';--> statement-breakpoint
UPDATE `analysis_runs` SET `analysis_kind` = CASE WHEN EXISTS (
	SELECT 1 FROM `_analysis_run_texts` `t` WHERE `t`.`id` = `analysis_runs`.`id` AND (
		`t`.`prompt` LIKE 'Classify the website%' OR `t`.`prompt` LIKE 'Classify the email%'
		OR `t`.`prompt` LIKE '%draft report%' OR `t`.`prompt` LIKE '%draft a report%' OR `t`.`prompt` LIKE '%draft the report%'
		OR `t`.`prompt` LIKE '%draft concise report%' OR `t`.`prompt` LIKE '%draft a concise report%' OR `t`.`prompt` LIKE '%draft the concise report%'
		OR (json_valid(`t`.`text`) AND json_type(`t`.`text`) = 'object' AND (
			((SELECT group_concat(`key`) FROM (SELECT `key` FROM json_each(`t`.`text`) ORDER BY `key`)) = 'phishing' AND json_type(`t`.`text`, '$.phishing') IN ('true', 'false'))
			OR ((SELECT group_concat(`key`) FROM (SELECT `key` FROM json_each(`t`.`text`) ORDER BY `key`)) = 'body,subject,to'
				AND json_type(`t`.`text`, '$.to') = 'text' AND json_type(`t`.`text`, '$.subject') = 'text' AND json_type(`t`.`text`, '$.body') = 'text')))
	)) THEN 'classification' ELSE 'analysis' END
WHERE `analysis_kind` = 'unknown';--> statement-breakpoint
DROP TABLE `_analysis_run_texts`;--> statement-breakpoint

PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_analysis_runs` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`submission_id` INTEGER NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`analysis_kind` text NOT NULL,
	`input` text,
	`output` text,
	`tokens_used` INTEGER,
	`data` text,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_analysis_runs`("id", "submission_id", "status", "analysis_kind", "input", "output", "tokens_used", "data", "created_at") SELECT "id", "submission_id", "status", "analysis_kind", "input", "output", "tokens_used", "data", "created_at" FROM `analysis_runs`;--> statement-breakpoint
DROP TABLE `analysis_runs`;--> statement-breakpoint
ALTER TABLE `__new_analysis_runs` RENAME TO `analysis_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `abuse_mail_messages` DROP COLUMN `extracted_links`;--> statement-breakpoint
ALTER TABLE `abuse_provider_routes` DROP COLUMN `verification_result`;--> statement-breakpoint
ALTER TABLE `abuse_provider_routes` DROP COLUMN `service_identity`;--> statement-breakpoint
ALTER TABLE `abuse_reports` DROP COLUMN `service_identity`;--> statement-breakpoint
ALTER TABLE `abuse_reports` DROP COLUMN `verification_outcome`;--> statement-breakpoint
ALTER TABLE `campaigns` DROP COLUMN `summary_generated_at`;