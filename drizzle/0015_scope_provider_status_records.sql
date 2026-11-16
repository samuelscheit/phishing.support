-- A provider's review-status record was keyed `provider-api:<provider>:status:<state>`,
-- the same key for every route, so only the first route to reach a state ever got
-- its record. Status keys now name their route; existing records move to that form.
UPDATE `abuse_mail_messages`
SET `correlation_key` = substr(`correlation_key`, 1, instr(`correlation_key`, ':status:') + 7) || `route_id` || ':' || substr(`correlation_key`, instr(`correlation_key`, ':status:') + 8)
WHERE `kind` = 'provider_api' AND `route_id` IS NOT NULL AND `correlation_key` LIKE 'provider-api:%:status:%';
