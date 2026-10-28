DROP INDEX `abuse_reports_submission_unique`;--> statement-breakpoint
CREATE INDEX `abuse_reports_submission_idx` ON `abuse_reports` (`submission_id`);