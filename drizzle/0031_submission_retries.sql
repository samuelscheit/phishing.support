-- Every retry of a failed or unreported case ("Analyze again", or the automatic retry of a browser-service failure or
-- restart), with the status, info line and finding it replaced. A row is written in the transaction that claims the
-- case for the retry, so a refused or lost claim leaves none. Cases retried before this migration have no rows.
CREATE TABLE `submission_retries` (
	`id` INTEGER PRIMARY KEY NOT NULL,
	`submission_id` INTEGER NOT NULL,
	`from_status` text NOT NULL,
	`previous_info` text,
	`previous_finding` text,
	`trigger` text NOT NULL,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `submission_retries_submission_created_idx` ON `submission_retries` (`submission_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `submission_retries_created_idx` ON `submission_retries` (`created_at`);