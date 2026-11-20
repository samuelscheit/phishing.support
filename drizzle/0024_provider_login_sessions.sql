CREATE TABLE `provider_login_sessions` (
	`session_key` text PRIMARY KEY NOT NULL,
	`session` text,
	`expires_at` INTEGER,
	`failure_message` text,
	`failure_until` INTEGER,
	`updated_at` INTEGER NOT NULL
);
--> statement-breakpoint
DROP TABLE `cloudflare_dashboard_sessions`;