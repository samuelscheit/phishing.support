-- Skyvern is replaced by the browser task agent, which runs inside the
-- run_portal job: a run is `task_started` from the moment its agent may act
-- until it settles, and there is no external run to reconcile.
--
-- A Skyvern run that was still in flight at the cutover can no longer be
-- read back, so it is treated like an interrupted task: its run becomes
-- `task_started` and its pending reconcile job becomes a run_portal job. That
-- job finds the started task and fences the route as unknown_external_state
-- (recording the events, recomputing the report status and cancelling the
-- Fabric browser) for an operator to check with the provider.
UPDATE `abuse_provider_runs` SET `execution_status` = 'task_started'
	WHERE `execution_status` = 'task_creation_started'
	OR (`execution_status` = 'running' AND `skyvern_run_id` IS NOT NULL);--> statement-breakpoint
UPDATE `abuse_jobs` SET `job_type` = 'run_portal', `payload` = '{}', `dedupe_key` = 'skyvern-cutover:' || `id`
	WHERE `job_type` = 'reconcile_skyvern_run' AND `status` IN ('queued', 'running');--> statement-breakpoint
DROP TABLE `abuse_webhook_events`;--> statement-breakpoint
DROP INDEX `abuse_provider_runs_skyvern_run_unique`;--> statement-breakpoint
ALTER TABLE `abuse_provider_runs` DROP COLUMN `skyvern_run_id`;