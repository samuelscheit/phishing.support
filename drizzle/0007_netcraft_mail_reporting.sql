ALTER TABLE `provider_reports` ADD `operation_key` text;--> statement-breakpoint
ALTER TABLE `provider_reports` ADD `provider_submission_url` text;--> statement-breakpoint
ALTER TABLE `provider_reports` ADD `error` text;--> statement-breakpoint
CREATE UNIQUE INDEX `provider_reports_operation_key_unique` ON `provider_reports` (`operation_key`);
