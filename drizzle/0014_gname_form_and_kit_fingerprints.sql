DROP TABLE `abuse_mail_codes`;--> statement-breakpoint
-- The GNAME Skyvern portal was never enabled; its routes were only ever
-- `no_route` placeholders. GNAME is now a direct provider submission.
DELETE FROM `abuse_provider_routes` WHERE `route_type` = 'skyvern_portal';--> statement-breakpoint
DELETE FROM `abuse_jobs` WHERE `job_type` IN ('verify_provider', 'deliver_provider_verification_code');
--> statement-breakpoint
-- Kit fingerprints name their kind (script, stylesheet, hidden frame) instead
-- of a MIME type; entries that were neither script nor stylesheet were never
-- kit fingerprints.
UPDATE `abuse_provider_routes`
SET `resolution_snapshot` = json_set(`resolution_snapshot`, '$.fingerprints', json((
	SELECT json_group_array(json_object(
		'sha256', json_extract(`value`, '$.sha256'),
		'kind', CASE WHEN json_extract(`value`, '$.mimeType') IN ('text/css', 'stylesheet') THEN 'stylesheet' ELSE 'script' END,
		'url', json_extract(`value`, '$.url'),
		'size', json_extract(`value`, '$.size')
	))
	FROM json_each(`resolution_snapshot`, '$.fingerprints')
	WHERE json_extract(`value`, '$.mimeType') IN ('text/css', 'stylesheet', 'text/javascript', 'application/javascript', 'application/x-javascript', 'script')
)))
WHERE json_type(`resolution_snapshot`, '$.fingerprints') = 'array';
