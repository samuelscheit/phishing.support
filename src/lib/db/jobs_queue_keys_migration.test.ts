import { expect, test } from "bun:test";

import { applyMigration, databaseBefore } from "./migration_test_helpers";

const MIGRATION = "0036_jobs_queue_keys";

test("0036 renames abuse_jobs to jobs with its rows, keys route jobs serially, and repoints the events' job foreign key", () => {
	// Foreign keys are off as in the migrator: the route row job 1 names need not exist.
	const database = databaseBefore(MIGRATION);
	database.exec(`
		INSERT INTO submissions (id, kind, data, dedupe_key, status) VALUES (1, 'website', '{}', 'one', 'reported');
		INSERT INTO abuse_reports (id, submission_id, tracking_token_hash, request_payload_hash, allegation_category, description) VALUES (1, 1, 't', 'p', 'phishing', 'd');
		INSERT INTO abuse_targets (id, report_id, ordinal, original_input, original_inputs, normalized_target, target_type) VALUES (1, 1, 0, 'kit.example', '[]', 'kit.example', 'domain');
		INSERT INTO abuse_jobs (id, job_type, report_id, route_id, next_attempt_at, status) VALUES (1, 'send_email', 1, 7, 0, 'queued'), (2, 'resolve_report', 1, NULL, 0, 'running');
		INSERT INTO abuse_events (id, report_id, job_id, event_type) VALUES (1, 1, 1, 'job.queued');
	`);
	applyMigration(database, MIGRATION);

	const tables = (database.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
	expect(tables).toContain("jobs");
	expect(tables).not.toContain("abuse_jobs");
	expect(database.query("SELECT id, job_type, status, serial_key, fair_key FROM jobs ORDER BY id").all()).toEqual([
		{ id: 1n, job_type: "send_email", status: "queued", serial_key: "route:7", fair_key: null },
		{ id: 2n, job_type: "resolve_report", status: "running", serial_key: null, fair_key: null },
	]);
	const eventKeys = database.query("PRAGMA foreign_key_list(abuse_events)").all() as Array<{ table: string; from: string }>;
	expect(eventKeys.find((key) => key.from === "job_id")?.table).toBe("jobs");
	const indexes = (database.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs'").all() as Array<{ name: string }>).map((row) => row.name).sort();
	expect(indexes).toEqual(["jobs_claim_idx", "jobs_dedupe_idx", "jobs_route_status_idx", "jobs_serial_status_idx", "jobs_type_fair_status_idx"]);

	// The event's job foreign key still acts: deleting the job clears it.
	database.exec("PRAGMA foreign_keys = ON");
	database.exec("DELETE FROM jobs WHERE id = 1");
	expect(database.query("SELECT job_id FROM abuse_events").all()).toEqual([{ job_id: null }]);
	expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
