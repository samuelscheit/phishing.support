DROP INDEX `artifacts_sha256_size_unique`;--> statement-breakpoint
DROP INDEX `report_messages_thread_message_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `report_messages_outbound_message_id_unique` ON `report_messages` (`message_id`) WHERE "report_messages"."direction" = 'outbound' and "report_messages"."message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `report_messages_inbound_message_id_unique` ON `report_messages` (`message_id`) WHERE "report_messages"."direction" = 'inbound' and "report_messages"."message_id" is not null;