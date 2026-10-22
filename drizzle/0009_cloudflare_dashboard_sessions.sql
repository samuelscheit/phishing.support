CREATE TABLE `cloudflare_dashboard_sessions` (
	`session_key` text PRIMARY KEY NOT NULL,
	`atok` text,
	`vses2` text,
	`expires_at` INTEGER,
	`failure_message` text,
	`failure_until` INTEGER,
	`updated_at` INTEGER NOT NULL
);
