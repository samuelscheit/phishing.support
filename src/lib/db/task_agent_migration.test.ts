import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const migrationFolder = join(process.cwd(), "drizzle");
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function applySqlMigration(database: Database, name: string) {
	const source = readFileSync(join(migrationFolder, name), "utf-8");
	for (const statement of source.split("--> statement-breakpoint")) {
		if (statement.trim()) database.exec(statement);
	}
}

test("Skyvern runs still in flight become started browser tasks whose pending reconcile jobs fence them through run_portal", () => {
	const directory = mkdtempSync(join(tmpdir(), "phishing-reporter-task-agent-migration-"));
	temporaryDirectories.push(directory);
	const database = new Database(join(directory, "cutover.sqlite"), { safeIntegers: true });
	database.exec(`
		CREATE TABLE abuse_provider_runs (id integer PRIMARY KEY, execution_status text NOT NULL, skyvern_run_id text);
		CREATE UNIQUE INDEX abuse_provider_runs_skyvern_run_unique ON abuse_provider_runs (skyvern_run_id);
		CREATE TABLE abuse_jobs (id integer PRIMARY KEY, job_type text NOT NULL, run_id integer, payload text, dedupe_key text, status text NOT NULL);
		CREATE TABLE abuse_webhook_events (id integer PRIMARY KEY, event_id text NOT NULL, skyvern_run_id text);
	`);
	const run = database.query("INSERT INTO abuse_provider_runs (id, execution_status, skyvern_run_id) VALUES (?, ?, ?)");
	run.run(1n, "running", "tsk_in_flight");
	run.run(2n, "task_creation_started", null);
	run.run(3n, "completed", "tsk_done");
	run.run(4n, "running", null);
	run.run(5n, "delivered", null);
	const job = database.query("INSERT INTO abuse_jobs (id, job_type, run_id, payload, dedupe_key, status) VALUES (?, ?, ?, ?, ?, ?)");
	job.run(10n, "reconcile_skyvern_run", 1n, '{"skyvernRunId":"tsk_in_flight"}', "reconcile:1:tsk_in_flight", "queued");
	job.run(11n, "reconcile_skyvern_run", 1n, '{"skyvernRunId":"tsk_in_flight"}', "reconcile:1:tsk_in_flight:2", "running");
	job.run(12n, "reconcile_skyvern_run", 3n, '{"skyvernRunId":"tsk_done"}', "reconcile:3:tsk_done", "completed");
	job.run(13n, "send_email", 5n, "{}", "email:5", "queued");

	applySqlMigration(database, "0019_replace_skyvern_with_task_agent.sql");

	expect(database.query("SELECT id, execution_status FROM abuse_provider_runs ORDER BY id").all()).toEqual([
		{ id: 1n, execution_status: "task_started" },
		{ id: 2n, execution_status: "task_started" },
		{ id: 3n, execution_status: "completed" },
		// A direct-provider run that never had a Skyvern task is not a browser task.
		{ id: 4n, execution_status: "running" },
		{ id: 5n, execution_status: "delivered" },
	]);
	expect(database.query("SELECT id, job_type, payload, dedupe_key, status FROM abuse_jobs ORDER BY id").all()).toEqual([
		{ id: 10n, job_type: "run_portal", payload: "{}", dedupe_key: "skyvern-cutover:10", status: "queued" },
		{ id: 11n, job_type: "run_portal", payload: "{}", dedupe_key: "skyvern-cutover:11", status: "running" },
		// History stays as it was.
		{ id: 12n, job_type: "reconcile_skyvern_run", payload: '{"skyvernRunId":"tsk_done"}', dedupe_key: "reconcile:3:tsk_done", status: "completed" },
		{ id: 13n, job_type: "send_email", payload: "{}", dedupe_key: "email:5", status: "queued" },
	]);
	const columns = database.query("SELECT name FROM pragma_table_info('abuse_provider_runs')").all().map((row) => (row as { name: string }).name);
	expect(columns).toEqual(["id", "execution_status"]);
	expect(database.query("SELECT name FROM sqlite_master WHERE name IN ('abuse_webhook_events', 'abuse_provider_runs_skyvern_run_unique')").all()).toEqual([]);
});
