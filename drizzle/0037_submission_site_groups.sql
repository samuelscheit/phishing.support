ALTER TABLE `submissions` ADD `site_group` text;--> statement-breakpoint
CREATE INDEX `submissions_site_group_status_idx` ON `submissions` (`site_group`,`status`);