-- Cloudflare origin-host snapshots move from version 2 to 3: every server records how it was found (all earlier ones by the
-- TLS sweep), and the snapshot records the passive-DNS history it consulted (none before) and the unverified historical
-- addresses inside the host's networks (none before). Routes keep the snapshot their report was sent from; derived IP
-- targets carry a copy. Version 1 snapshots predate version 2 and stay unreadable, as they already were.
UPDATE `abuse_provider_routes` SET `resolution_snapshot` = json_set(`resolution_snapshot`,
	'$.version', 3,
	'$.servers', json((SELECT json_group_array(json_set(`value`, '$.discovery', 'tls_sweep')) FROM json_each(`abuse_provider_routes`.`resolution_snapshot`, '$.servers'))),
	'$.dnsHistory', json('{"hosts":[],"sources":[],"recordsFound":0}'),
	'$.historicalResolutions', json('[]'))
WHERE json_valid(`resolution_snapshot`) AND json_extract(`resolution_snapshot`, '$.kind') = 'cloudflare_origin_host' AND json_extract(`resolution_snapshot`, '$.version') = 2;--> statement-breakpoint
UPDATE `abuse_targets` SET `resolver_snapshot` = json_set(`resolver_snapshot`,
	'$.version', 3,
	'$.servers', json((SELECT json_group_array(json_set(`value`, '$.discovery', 'tls_sweep')) FROM json_each(`abuse_targets`.`resolver_snapshot`, '$.servers'))),
	'$.dnsHistory', json('{"hosts":[],"sources":[],"recordsFound":0}'),
	'$.historicalResolutions', json('[]'))
WHERE json_valid(`resolver_snapshot`) AND json_extract(`resolver_snapshot`, '$.kind') = 'cloudflare_origin_host' AND json_extract(`resolver_snapshot`, '$.version') = 2;
