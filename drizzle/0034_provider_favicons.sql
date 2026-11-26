-- The icon of each provider's website, by registrable domain, re-drawn as our own PNG. Fetched in the background
-- when a page first names the domain, kept for good, revalidated monthly; a domain without an icon is asked again
-- after a backoff. Each row is its own refresh job, due at `check_at`.
CREATE TABLE `favicons` (
	`domain` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`png` blob,
	`version` text,
	`source` text,
	`failure` text,
	`reason` text,
	`fetched_at` INTEGER,
	`check_at` INTEGER NOT NULL,
	`claimed_until` INTEGER,
	`created_at` INTEGER DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `favicons_check_at_idx` ON `favicons` (`check_at`);