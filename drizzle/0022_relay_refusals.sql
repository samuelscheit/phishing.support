-- Bounces our own relay sent (iCloud's outbound filter, Remote-MTA on loopback) were recorded as the provider's;
-- they are refusals of our relay (mail/relay_refusal.ts). Their resends are queued by the worker at start.
UPDATE `abuse_mail_messages` SET `classification` = 'relay_refused', `disposition` = 'relay_refusal'
WHERE `kind` = 'bounce'
	AND `classification` = 'bounce'
	AND (`text_body` LIKE '%Remote-MTA: dns; 127.%' OR `text_body` LIKE '%Remote-MTA: dns; [127.%' OR `text_body` LIKE '%Remote-MTA: dns; localhost%');
