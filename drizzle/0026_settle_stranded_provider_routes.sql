-- Routes stranded in unknown_external_state whose outcome no reader can confirm any more, settled by an operator after reading
-- their runs, events and artifacts, the Cloudflare account's submitted reports and the mailbox. A route whose request was
-- answered 2xx is submitted; every other route is failed. The ids, statuses and reasons are the whole decision:
-- on a database without these routes the statements change nothing.
--   google_safe_browsing (12): the provider is removed; every run ended interrupted, timed out or with a closed browser.
--   cloudflare (38): runs of the anonymous abuse form; the account lists no report for any of them.
--   netcraft (4): submitted — Netcraft answered each request 2xx but without a usable submission id (no lookup by URL).
CREATE TEMP TABLE `_settled_routes` (`route_id` INTEGER PRIMARY KEY NOT NULL, `reason` text NOT NULL, `status` text NOT NULL DEFAULT 'failed');--> statement-breakpoint
INSERT INTO `_settled_routes` (`route_id`, `reason`) VALUES
	(351388500236439563, 'google_safe_browsing provider removed; outcome never confirmed'),
	(353192648921583784, 'google_safe_browsing provider removed; outcome never confirmed'),
	(354307541699662322, 'google_safe_browsing provider removed; outcome never confirmed'),
	(354542145585025585, 'google_safe_browsing provider removed; outcome never confirmed'),
	(355426889780695294, 'google_safe_browsing provider removed; outcome never confirmed'),
	(355770765657772450, 'google_safe_browsing provider removed; outcome never confirmed'),
	(355885426994582055, 'google_safe_browsing provider removed; outcome never confirmed'),
	(356001856389911241, 'google_safe_browsing provider removed; outcome never confirmed'),
	(356103535730889686, 'google_safe_browsing provider removed; outcome never confirmed'),
	(356669701780150258, 'google_safe_browsing provider removed; outcome never confirmed'),
	(373043029558169832, 'google_safe_browsing provider removed; outcome never confirmed'),
	(374704629897762430, 'google_safe_browsing provider removed; outcome never confirmed'),
	(351388500093833223, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(351855087410221061, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(352185884885389319, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(352343157045727296, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(352730681983373317, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(352784888375545887, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(352800450291961942, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(352833577160806488, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(352855621785096335, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(352881294285213886, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(353089227145089031, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(353103579671695417, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(353180184775495785, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(353192648846086308, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(353330049761415185, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(353474236381139095, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(353509977668718841, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(353575403022979483, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(353716029173534727, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(353798487705391169, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(354138694409523627, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(354307541653524974, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(354542145421447725, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(354968255246373579, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(355060850219814915, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(355326252543905908, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(355770765640995230, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(355791411569758685, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(356052486018044692, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(356063360065737559, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(356103535709918162, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(356272887453193312, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(356285096048727197, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(356297397782975706, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(356452698616239697, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(356544987430655809, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(356706014801696833, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(356722857008437389, 'cloudflare: no matching report in the account''s submitted reports (the listing holds only its latest 50, from 2026-10-23); outcome never confirmed'),
	(351388500387434511, 'netcraft: answered 2xx without a usable submission id; Netcraft offers no lookup by URL'),
	(351855087561216013, 'netcraft: answered 2xx without a usable submission id; Netcraft offers no lookup by URL'),
	(352185885036384271, 'netcraft: answered 2xx without a usable submission id; Netcraft offers no lookup by URL'),
	(352343157368688712, 'netcraft: answered 2xx without a usable submission id; Netcraft offers no lookup by URL');--> statement-breakpoint
UPDATE `_settled_routes` SET `status` = 'submitted' WHERE `route_id` IN (351388500387434511, 351855087561216013, 352185885036384271, 352343157368688712);--> statement-breakpoint

INSERT INTO `abuse_events` (`id`, `report_id`, `target_id`, `route_id`, `event_type`, `data`, `created_at`)
SELECT (SELECT COALESCE(MAX(`id`), 0) FROM `abuse_events`) + row_number() OVER (ORDER BY `r`.`id`), `r`.`report_id`, `r`.`target_id`, `r`.`id`, 'route.status_changed',
	json_object('from', `r`.`status`, 'to', `s`.`status`, 'reason', `s`.`reason`, 'backfilled', json('true')), unixepoch() * 1000
FROM `abuse_provider_routes` `r` JOIN `_settled_routes` `s` ON `s`.`route_id` = `r`.`id`
WHERE `r`.`status` = 'unknown_external_state';--> statement-breakpoint
UPDATE `abuse_provider_runs` SET `updated_at` = unixepoch() * 1000,
	`execution_status` = (SELECT CASE `s`.`status` WHEN 'submitted' THEN 'completed' ELSE 'failed' END FROM `_settled_routes` `s` WHERE `s`.`route_id` = `abuse_provider_runs`.`route_id`),
	`failure_reason` = (SELECT CASE `s`.`status` WHEN 'submitted' THEN NULL ELSE `s`.`reason` END FROM `_settled_routes` `s` WHERE `s`.`route_id` = `abuse_provider_runs`.`route_id`)
WHERE `execution_status` = 'unknown_external_state' AND `route_id` IN (SELECT `route_id` FROM `_settled_routes`);--> statement-breakpoint
UPDATE `abuse_jobs` SET `updated_at` = unixepoch() * 1000,
	`status` = (SELECT CASE `s`.`status` WHEN 'submitted' THEN 'completed' ELSE 'failed' END FROM `_settled_routes` `s` WHERE `s`.`route_id` = `abuse_jobs`.`route_id`)
WHERE `status` = 'unknown_external_state' AND `job_type` = 'submit_provider' AND `route_id` IN (SELECT `route_id` FROM `_settled_routes`);--> statement-breakpoint
UPDATE `abuse_provider_routes` SET `updated_at` = unixepoch() * 1000,
	`status` = (SELECT `s`.`status` FROM `_settled_routes` `s` WHERE `s`.`route_id` = `abuse_provider_routes`.`id`)
WHERE `status` = 'unknown_external_state' AND `id` IN (SELECT `route_id` FROM `_settled_routes`);--> statement-breakpoint
DROP TABLE `_settled_routes`;
