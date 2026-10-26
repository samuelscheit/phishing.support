-- One reporting aggregate for website, email, and public API reports.
-- Every legacy report record (provider_reports, report_threads,
-- report_messages) is migrated into the abuse tables, then dropped.
ALTER TABLE `abuse_reports` ADD `submission_id` INTEGER REFERENCES submissions(id) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `abuse_reports` ADD `reporter_name` text;--> statement-breakpoint
ALTER TABLE `abuse_reports` DROP COLUMN `reporter_identity`;--> statement-breakpoint
UPDATE `abuse_reports`
SET `submission_id` = CAST(substr(`idempotency_key`, 16) AS INTEGER),
	`idempotency_key` = NULL
WHERE `idempotency_key` LIKE 'legacy-website:%'
	AND EXISTS (SELECT 1 FROM `submissions` s WHERE s.`id` = CAST(substr(`abuse_reports`.`idempotency_key`, 16) AS INTEGER));--> statement-breakpoint
CREATE UNIQUE INDEX `abuse_reports_submission_unique` ON `abuse_reports` (`submission_id`);--> statement-breakpoint

-- A report per submission that only has legacy records. Its id reuses the
-- submission id (snowflakes are globally unique), and its tracking token is
-- an unguessable hash, never handed out, because these predate tokens.
CREATE TEMP TABLE `__id_base` AS SELECT max(m) + 1 AS base FROM (
	SELECT max(`id`) m FROM `abuse_targets` UNION ALL SELECT max(`id`) FROM `abuse_reports` UNION ALL SELECT max(`id`) FROM `submissions`
	UNION ALL SELECT max(`id`) FROM `provider_reports` UNION ALL SELECT max(`id`) FROM `report_threads` UNION ALL SELECT 0);--> statement-breakpoint
CREATE TEMP TABLE `__legacy_submissions` AS
SELECT s.`id` AS submission_id, s.`kind`, s.`data`, s.`reporter_ip`, s.`reporter_country`, s.`reporter_headers`,
	COALESCE((SELECT MIN(x.created_at) FROM (
		SELECT p.`created_at` FROM `provider_reports` p WHERE p.`submission_id` = s.`id`
		UNION ALL SELECT t.`created_at` FROM `report_threads` t WHERE t.`submission_id` = s.`id`
	) x), s.`created_at`) AS created_at,
	COALESCE((SELECT MAX(x.updated_at) FROM (
		SELECT p.`updated_at` FROM `provider_reports` p WHERE p.`submission_id` = s.`id`
		UNION ALL SELECT t.`updated_at` FROM `report_threads` t WHERE t.`submission_id` = s.`id`
	) x), s.`updated_at`) AS updated_at
FROM `submissions` s
WHERE (EXISTS (SELECT 1 FROM `provider_reports` p WHERE p.`submission_id` = s.`id`)
		OR EXISTS (SELECT 1 FROM `report_threads` t WHERE t.`submission_id` = s.`id`))
	AND NOT EXISTS (SELECT 1 FROM `abuse_reports` a WHERE a.`submission_id` = s.`id`);--> statement-breakpoint
INSERT INTO `abuse_reports` (`id`, `submission_id`, `tracking_token_hash`, `idempotency_key`, `request_payload_hash`, `allegation_category`, `description`, `status`, `requester_ip`, `requester_country`, `requester_headers`, `created_at`, `updated_at`)
SELECT l.submission_id, l.submission_id, lower(hex(randomblob(32))), NULL, 'migrated-legacy-report',
	'phishing', 'Migrated from the previous reporting pipeline.', 'submitted', l.reporter_ip, l.reporter_country, l.reporter_headers, l.created_at, l.updated_at
FROM `__legacy_submissions` l;--> statement-breakpoint

-- One target per migrated submission: the website's host, or the reported
-- email. Migrated ids are allocated above every existing id, so they can
-- never collide with a stored or later generated snowflake of the past.
CREATE TEMP TABLE `__legacy_hosts` AS
SELECT l.submission_id, trim(json_extract(l.data, '$.website.url')) AS url,
	substr(trim(json_extract(l.data, '$.website.url')), instr(trim(json_extract(l.data, '$.website.url')), '://') + 3) AS rest
FROM `__legacy_submissions` l WHERE l.kind = 'website';--> statement-breakpoint
UPDATE `__legacy_hosts` SET rest = substr(rest, 1, instr(rest, '/') - 1) WHERE instr(rest, '/') > 0;--> statement-breakpoint
UPDATE `__legacy_hosts` SET rest = substr(rest, 1, instr(rest, '?') - 1) WHERE instr(rest, '?') > 0;--> statement-breakpoint
UPDATE `__legacy_hosts` SET rest = substr(rest, 1, instr(rest, '#') - 1) WHERE instr(rest, '#') > 0;--> statement-breakpoint
UPDATE `__legacy_hosts` SET rest = substr(rest, instr(rest, '@') + 1) WHERE instr(rest, '@') > 0;--> statement-breakpoint
UPDATE `__legacy_hosts` SET rest = substr(rest, 1, instr(rest, ':') - 1) WHERE instr(rest, ':') > 0;--> statement-breakpoint
INSERT INTO `abuse_targets` (`id`, `report_id`, `ordinal`, `original_input`, `original_inputs`, `normalized_target`, `target_type`, `observed_urls`, `resolution_status`, `disposition`, `created_at`, `updated_at`)
SELECT (SELECT base FROM `__id_base`) + 2 * (ROW_NUMBER() OVER (ORDER BY a.`id`)), a.`id`, 0,
	COALESCE(h.url, 'phishing-email'),
	json_array(COALESCE(h.url, 'phishing-email')),
	COALESCE(lower(rtrim(h.rest, '.')), 'phishing-email'),
	CASE l.kind WHEN 'website' THEN 'domain' ELSE 'email' END,
	CASE l.kind WHEN 'website' THEN json_array(h.url) ELSE '[]' END,
	'resolved', 'migrated_legacy_report', l.created_at, l.updated_at
FROM `__legacy_submissions` l
JOIN `abuse_reports` a ON a.`submission_id` = l.submission_id
LEFT JOIN `__legacy_hosts` h ON h.submission_id = l.submission_id;--> statement-breakpoint

-- An email's abuse mailbox belonged to its sending IP: give the migrated
-- report that IP as a second target (as new email reports have).
INSERT INTO `abuse_targets` (`id`, `report_id`, `ordinal`, `original_input`, `original_inputs`, `normalized_target`, `target_type`, `observed_urls`, `resolution_status`, `disposition`, `created_at`, `updated_at`)
SELECT (SELECT base FROM `__id_base`) + 2 * (ROW_NUMBER() OVER (ORDER BY a.`id`)) + 1, a.`id`, 1, json_extract(l.data, '$.email.headers.routing.originatingIp'),
	json_array(json_extract(l.data, '$.email.headers.routing.originatingIp')),
	lower(json_extract(l.data, '$.email.headers.routing.originatingIp')), 'ip', '[]',
	'resolved', 'migrated_legacy_report', l.created_at, l.updated_at
FROM `__legacy_submissions` l
JOIN `abuse_reports` a ON a.`submission_id` = l.submission_id
WHERE l.kind = 'email' AND json_extract(l.data, '$.email.headers.routing.originatingIp') IS NOT NULL;--> statement-breakpoint

-- Every report that receives legacy rows needs a target to attach them to:
-- its first target, and for abuse-mailbox rows of an email its sending IP.
CREATE TEMP TABLE `__legacy_report_targets` AS
SELECT a.`id` AS report_id, a.`submission_id`,
	(SELECT t.`id` FROM `abuse_targets` t WHERE t.`report_id` = a.`id` ORDER BY t.`ordinal` LIMIT 1) AS target_id,
	COALESCE(
		(SELECT t.`id` FROM `abuse_targets` t WHERE t.`report_id` = a.`id` AND t.`target_type` = 'ip' ORDER BY t.`ordinal` LIMIT 1),
		(SELECT t.`id` FROM `abuse_targets` t WHERE t.`report_id` = a.`id` ORDER BY t.`ordinal` LIMIT 1)
	) AS mail_target_id
FROM `abuse_reports` a
WHERE a.`submission_id` IS NOT NULL
	AND (EXISTS (SELECT 1 FROM `provider_reports` p WHERE p.`submission_id` = a.`submission_id`)
		OR EXISTS (SELECT 1 FROM `report_threads` t WHERE t.`submission_id` = a.`submission_id`));--> statement-breakpoint

-- Legacy SMTP threads become email routes with their full correspondence.
-- A thread whose outbound message already exists in abuse_mail_messages was
-- sent by the reporting worker; only its replies are attached to that route.
CREATE TEMP TABLE `__thread_routes` AS
SELECT t.`id` AS thread_id, rt.report_id, rt.mail_target_id AS target_id,
	(SELECT am.`route_id` FROM `report_messages` m JOIN `abuse_mail_messages` am ON am.`message_id` = m.`message_id` AND am.`direction` = 'outbound'
		WHERE m.`thread_id` = t.`id` AND m.`direction` = 'outbound' LIMIT 1) AS existing_route_id,
	t.*
FROM `report_threads` t JOIN `__legacy_report_targets` rt ON rt.`submission_id` = t.`submission_id`;--> statement-breakpoint
INSERT INTO `abuse_provider_routes` (`id`, `report_id`, `target_id`, `route_key`, `provider_registry_key`, `provider_display_name`, `route_type`, `verified_email`, `resolver_provenance`, `resolution_snapshot`, `verification_result`, `status`, `created_at`, `updated_at`)
SELECT tr.thread_id, tr.report_id, tr.target_id,
	'legacy-thread:' || tr.thread_id,
	'email:' || substr(json_extract(tr.`to`, '$[0]'), instr(json_extract(tr.`to`, '$[0]'), '@') + 1),
	json_extract(tr.`to`, '$[0]'),
	'email', json_extract(tr.`to`, '$[0]'),
	json_object('source', 'migrated_legacy_report_thread'), json_object('source', 'migrated_legacy_report_thread'),
	json_object('verified', json('true'), 'method', 'migrated_legacy_report_thread'),
	CASE tr.`status` WHEN 'sent' THEN 'awaiting_provider_reply' WHEN 'replied' THEN 'acknowledged' WHEN 'delivery_failed' THEN 'delivery_failed' WHEN 'failed' THEN 'failed' WHEN 'closed' THEN 'acknowledged' ELSE 'failed' END,
	tr.`created_at`, tr.`updated_at`
FROM `__thread_routes` tr WHERE tr.existing_route_id IS NULL;--> statement-breakpoint

-- Correspondence artifacts (sent MIME, attachments, replies) keep their ids.
-- A thread already sent by the reporting worker keeps the worker's copy of
-- its outbound mail; the legacy duplicate is still retained on the route.
INSERT INTO `abuse_artifacts` (`id`, `report_id`, `route_id`, `name`, `kind`, `mime_type`, `sha256`, `size`, `metadata`, `blob`, `created_at`)
SELECT ar.`id`, tr.report_id, COALESCE(tr.existing_route_id, tr.thread_id), COALESCE(ar.`name`, 'artifact'),
	CASE ar.`kind` WHEN 'report_eml' THEN 'outbound_mail_mime' WHEN 'report_attachment' THEN 'outbound_mail_attachment'
		WHEN 'report_reply_eml' THEN 'inbound_mail_mime' WHEN 'report_reply_attachment' THEN 'inbound_mail_attachment' ELSE ar.`kind` END,
	COALESCE(ar.`mime_type`, 'application/octet-stream'), COALESCE(ar.`sha256`, ''), COALESCE(ar.`size`, length(ar.`blob`)),
	json_object('source', 'migrated_legacy_artifact'), ar.`blob`, ar.`created_at`
FROM `report_messages` m
JOIN `__thread_routes` tr ON tr.thread_id = m.`thread_id`
JOIN `artifacts` ar ON ar.`id` = m.`raw_artifact_id`
	OR ar.`id` IN (SELECT CAST(j.`value` AS INTEGER) FROM json_each(m.`attachment_artifact_ids`) j)
WHERE NOT EXISTS (SELECT 1 FROM `abuse_artifacts` x WHERE x.`id` = ar.`id`)
GROUP BY ar.`id`;--> statement-breakpoint
INSERT INTO `abuse_mail_messages` (`id`, `report_id`, `route_id`, `direction`, `kind`, `status`, `from_address`, `to_addresses`, `subject`, `text_body`, `message_id`, `in_reply_to`, `references`, `reply_address`, `classification`, `raw_artifact_id`, `attachment_artifact_ids`, `error`, `occurred_at`, `created_at`, `updated_at`)
SELECT m.`id`, tr.report_id, COALESCE(tr.existing_route_id, tr.thread_id), m.`direction`,
	CASE m.`direction` WHEN 'outbound' THEN 'report' ELSE 'reply' END,
	m.`status`, m.`from`, m.`to`, m.`subject`, m.`text_body`, m.`message_id`, m.`in_reply_to`, m.`references`,
	CASE m.`direction` WHEN 'outbound' THEN tr.`reply_address` END,
	CASE m.`kind` WHEN 'bounce' THEN 'bounce' WHEN 'auto_reply' THEN 'acknowledged' WHEN 'reply' THEN 'acknowledged' END,
	m.`raw_artifact_id`, m.`attachment_artifact_ids`, m.`error`, m.`occurred_at`, m.`created_at`, m.`updated_at`
FROM `report_messages` m JOIN `__thread_routes` tr ON tr.thread_id = m.`thread_id`
WHERE tr.existing_route_id IS NULL OR m.`direction` = 'inbound';--> statement-breakpoint
-- A migrated provider reply settles the route it answers.
UPDATE `abuse_provider_routes` SET `status` = 'acknowledged'
WHERE `status` = 'awaiting_provider_reply'
	AND `id` IN (SELECT tr.existing_route_id FROM `__thread_routes` tr JOIN `report_messages` m ON m.`thread_id` = tr.thread_id
		WHERE tr.existing_route_id IS NOT NULL AND m.`direction` = 'inbound' AND m.`kind` <> 'bounce');--> statement-breakpoint

-- Every other legacy record (direct provider submissions, Netcraft mail,
-- pre-thread SMTP reports) becomes a settled route with its historical text.
INSERT INTO `abuse_provider_routes` (`id`, `report_id`, `target_id`, `route_key`, `provider_registry_key`, `provider_display_name`, `route_type`, `verified_email`, `resolver_provenance`, `resolution_snapshot`, `verification_result`, `status`, `created_at`, `updated_at`)
SELECT p.`id`, rt.report_id, CASE WHEN p.`channel` = 'email' AND p.`to` LIKE '%@%' THEN rt.mail_target_id ELSE rt.target_id END,
	'legacy-report:' || p.`id`,
	CASE WHEN p.`channel` = 'netcraft_mail_v3' THEN 'netcraft_mail'
		WHEN p.`to` LIKE '%@%' THEN 'email:' || substr(p.`to`, instr(p.`to`, '@') + 1)
		ELSE 'historical:' || lower(replace(p.`to`, ' ', '_')) END,
	CASE WHEN p.`channel` = 'netcraft_mail_v3' THEN 'Netcraft' ELSE p.`to` END,
	CASE WHEN p.`to` LIKE '%@%' AND p.`channel` = 'email' THEN 'email' ELSE 'provider_submission' END,
	CASE WHEN p.`to` LIKE '%@%' THEN p.`to` END,
	json_object('source', 'migrated_legacy_provider_report', 'channel', p.`channel`), json_object('source', 'migrated_legacy_provider_report'),
	json_object('verified', json('true'), 'method', 'migrated_legacy_provider_report'),
	CASE p.`status` WHEN 'sent' THEN 'submitted' WHEN 'failed' THEN 'provider_rejected' WHEN 'unknown_external_state' THEN 'unknown_external_state'
		WHEN 'submission_started' THEN 'unknown_external_state' ELSE 'failed' END,
	p.`created_at`, p.`updated_at`
FROM `provider_reports` p JOIN `__legacy_report_targets` rt ON rt.`submission_id` = p.`submission_id`;--> statement-breakpoint
INSERT INTO `abuse_provider_runs` (`id`, `report_id`, `route_id`, `provider_payload`, `payload_hash`, `correlation_key`, `attempt_count`, `execution_status`, `confirmation_id`, `confirmation_text`, `final_url`, `submitted_targets`, `failure_reason`, `created_at`, `updated_at`)
SELECT p.`id`, rt.report_id, p.`id`,
	json_object('adapter', 'historical_report', 'channel', p.`channel`, 'subject', p.`subject`, 'body', p.`body`, 'data', json(COALESCE(p.`data`, 'null'))),
	'migrated-legacy-report', 'legacy-report:' || p.`id`, 1,
	CASE p.`status` WHEN 'sent' THEN 'completed' WHEN 'failed' THEN 'failed' WHEN 'unknown_external_state' THEN 'unknown_external_state'
		WHEN 'submission_started' THEN 'unknown_external_state' ELSE 'failed' END,
	NULLIF(p.`provider_message_id`, ''),
	CASE WHEN p.`status` = 'sent' THEN 'Submitted by the previous reporting pipeline.' END,
	p.`provider_submission_url`,
	CASE WHEN p.`status` = 'sent' THEN json_array((SELECT t.`normalized_target` FROM `abuse_targets` t JOIN `abuse_provider_routes` r ON r.`target_id` = t.`id` WHERE r.`id` = p.`id`)) ELSE '[]' END,
	p.`error`, p.`created_at`, p.`updated_at`
FROM `provider_reports` p JOIN `__legacy_report_targets` rt ON rt.`submission_id` = p.`submission_id`;--> statement-breakpoint
-- Legacy attachments of provider reports (the reported EML) become report evidence.
INSERT INTO `abuse_artifacts` (`id`, `report_id`, `route_id`, `name`, `kind`, `mime_type`, `sha256`, `size`, `metadata`, `blob`, `created_at`)
SELECT ar.`id`, rt.report_id, p.`id`, COALESCE(ar.`name`, 'artifact'), 'user_evidence_original',
	COALESCE(ar.`mime_type`, 'application/octet-stream'), COALESCE(ar.`sha256`, ''), COALESCE(ar.`size`, length(ar.`blob`)),
	json_object('source', 'migrated_legacy_artifact'), ar.`blob`, ar.`created_at`
FROM `provider_reports` p
JOIN `__legacy_report_targets` rt ON rt.`submission_id` = p.`submission_id`
JOIN json_each(COALESCE(p.`attachments_artifact_ids`, '[]')) j
JOIN `artifacts` ar ON ar.`id` = CAST(j.`value` AS INTEGER)
WHERE NOT EXISTS (SELECT 1 FROM `abuse_artifacts` x WHERE x.`id` = ar.`id`)
GROUP BY ar.`id`;--> statement-breakpoint

-- Recompute every settled report with the current rollup: a delivered route
-- makes the report (partially) submitted even when another provider failed.
-- Reports with work still in progress keep their status until the worker settles them.
UPDATE `abuse_reports` SET `status` = CASE
		WHEN EXISTS (SELECT 1 FROM `abuse_provider_routes` r WHERE r.`report_id` = `abuse_reports`.`id` AND r.`status` IN ('submitted', 'acknowledged', 'awaiting_provider_reply'))
			AND EXISTS (SELECT 1 FROM `abuse_provider_routes` r WHERE r.`report_id` = `abuse_reports`.`id` AND r.`status` NOT IN ('submitted', 'acknowledged', 'awaiting_provider_reply', 'no_route'))
			THEN 'partially_submitted'
		WHEN EXISTS (SELECT 1 FROM `abuse_provider_routes` r WHERE r.`report_id` = `abuse_reports`.`id` AND r.`status` = 'awaiting_provider_reply') THEN 'waiting_provider'
		WHEN EXISTS (SELECT 1 FROM `abuse_provider_routes` r WHERE r.`report_id` = `abuse_reports`.`id` AND r.`status` IN ('submitted', 'acknowledged')) THEN 'submitted'
		WHEN NOT EXISTS (SELECT 1 FROM `abuse_provider_routes` r WHERE r.`report_id` = `abuse_reports`.`id` AND r.`status` <> 'no_route') THEN 'no_route'
		WHEN EXISTS (SELECT 1 FROM `abuse_provider_routes` r WHERE r.`report_id` = `abuse_reports`.`id` AND r.`status` = 'needs_human') THEN 'needs_human'
		WHEN NOT EXISTS (SELECT 1 FROM `abuse_provider_routes` r WHERE r.`report_id` = `abuse_reports`.`id` AND r.`status` NOT IN ('insufficient_evidence', 'no_route')) THEN 'insufficient_evidence'
		ELSE 'failed' END
WHERE `status` <> 'canceled'
	AND EXISTS (SELECT 1 FROM `abuse_provider_routes` r WHERE r.`report_id` = `abuse_reports`.`id`)
	AND NOT EXISTS (SELECT 1 FROM `abuse_provider_routes` r WHERE r.`report_id` = `abuse_reports`.`id`
		AND r.`status` IN ('resolving', 'verified', 'queued', 'running', 'waiting_code', 'escalating_to_portal'));--> statement-breakpoint

-- Correspondence artifacts moved to the report; the submission keeps only its own evidence.
DELETE FROM `artifacts` WHERE `kind` IN ('report_eml', 'report_attachment', 'report_reply_eml', 'report_reply_attachment')
	AND `id` IN (SELECT `id` FROM `abuse_artifacts`);--> statement-breakpoint
DROP TABLE `__legacy_submissions`;--> statement-breakpoint
DROP TABLE `__id_base`;--> statement-breakpoint
DROP TABLE `__legacy_hosts`;--> statement-breakpoint
DROP TABLE `__legacy_report_targets`;--> statement-breakpoint
DROP TABLE `__thread_routes`;--> statement-breakpoint
-- mail_ingest is a small ledger; rebuild it without the legacy message link.
CREATE TABLE `__new_mail_ingest` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`mailbox` text NOT NULL,
	`uid_validity` INTEGER NOT NULL,
	`uid` INTEGER NOT NULL,
	`message_id` text,
	`route` text NOT NULL,
	`reason` text,
	`attempts` INTEGER DEFAULT 1 NOT NULL,
	`terminal` integer DEFAULT true NOT NULL,
	`processed_at` INTEGER NOT NULL,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_mail_ingest` (`id`, `mailbox`, `uid_validity`, `uid`, `message_id`, `route`, `reason`, `attempts`, `terminal`, `processed_at`, `created_at`, `updated_at`)
SELECT `id`, `mailbox`, `uid_validity`, `uid`, `message_id`, `route`, `reason`, `attempts`, `terminal`, `processed_at`, `created_at`, `updated_at` FROM `mail_ingest`;--> statement-breakpoint
DROP TABLE `mail_ingest`;--> statement-breakpoint
ALTER TABLE `__new_mail_ingest` RENAME TO `mail_ingest`;--> statement-breakpoint
CREATE UNIQUE INDEX `mail_ingest_mailbox_uid_unique` ON `mail_ingest` (`mailbox`,`uid_validity`,`uid`);--> statement-breakpoint
CREATE INDEX `mail_ingest_message_id_idx` ON `mail_ingest` (`message_id`);--> statement-breakpoint
CREATE INDEX `mail_ingest_route_processed_idx` ON `mail_ingest` (`route`,`processed_at`);--> statement-breakpoint
DROP TABLE `report_messages`;--> statement-breakpoint
DROP TABLE `report_threads`;--> statement-breakpoint
DROP TABLE `provider_reports`;
