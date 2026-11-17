CREATE TABLE `campaign_site_facts` (
	`submission_id` INTEGER PRIMARY KEY NOT NULL,
	`language` text,
	`thumbnail_artifact_id` INTEGER,
	`updated_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `campaigns` ADD `title` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `summary_site_count` INTEGER;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `summary_generated_at` INTEGER;