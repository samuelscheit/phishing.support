CREATE TABLE `site_checks` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`report_id` INTEGER NOT NULL,
	`target_id` INTEGER NOT NULL,
	`url` text NOT NULL,
	`state` text NOT NULL,
	`http_status` INTEGER,
	`final_url` text,
	`resolved_addresses` text DEFAULT '[]' NOT NULL,
	`domain_statuses` text DEFAULT '[]' NOT NULL,
	`detail` text,
	`checked_at` INTEGER NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `abuse_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `abuse_targets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `site_checks_target_checked_idx` ON `site_checks` (`target_id`,`checked_at`);--> statement-breakpoint
-- Review states read from provider APIs before providers named their verdicts (`reviewVerdicts`).
UPDATE `abuse_mail_messages` SET `classification` = CASE
	WHEN r.`provider_registry_key` = 'cloudflare' AND `abuse_mail_messages`.`subject` = 'Report status: accepted' THEN 'acknowledged'
	WHEN r.`provider_registry_key` = 'cloudflare' AND `abuse_mail_messages`.`subject` = 'Report status: denied' THEN 'rejected'
	WHEN r.`provider_registry_key` = 'eranet' AND `abuse_mail_messages`.`subject` = 'Report status: supplement required' THEN 'needs_more_information'
	WHEN r.`provider_registry_key` = 'eranet' AND `abuse_mail_messages`.`subject` IN ('Report status: processing', 'Report status: process completed') THEN 'acknowledged'
END
FROM `abuse_provider_routes` r
WHERE r.`id` = `abuse_mail_messages`.`route_id`
	AND `abuse_mail_messages`.`kind` = 'provider_api'
	AND `abuse_mail_messages`.`classification` IS NULL
	AND `abuse_mail_messages`.`subject` IN ('Report status: accepted', 'Report status: denied', 'Report status: supplement required', 'Report status: processing', 'Report status: process completed');
--> statement-breakpoint
-- Netcraft's analysis mails were all recorded as acknowledged; "no threats were found" is its rejection.
UPDATE `abuse_mail_messages` SET `classification` = 'rejected'
FROM `abuse_provider_routes` r
WHERE r.`id` = `abuse_mail_messages`.`route_id`
	AND r.`provider_registry_key` IN ('netcraft', 'netcraft_mail')
	AND `abuse_mail_messages`.`kind` = 'notification'
	AND `abuse_mail_messages`.`classification` = 'acknowledged'
	AND REPLACE(REPLACE(REPLACE(`abuse_mail_messages`.`text_body`, char(13), ''), char(9), ' '), char(10), ' ') LIKE '%no threats were found%';
