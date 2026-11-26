import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { applyMigration, databaseBefore } from "./migration_test_helpers";

const MIGRATION = "0032_enforce_foreign_keys";

const count = (database: Database, table: string) => (database.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: bigint }).n;

/**
 * Production, never enforcing foreign keys, kept the children of deleted
 * cases and the job ids of discarded jobs. The rows below are those orphans
 * beside rows whose parents exist.
 */
function databaseWithOrphans(): Database {
	const database = databaseBefore(MIGRATION);
	database.exec(`
		INSERT INTO submissions (id, kind, data, dedupe_key, status) VALUES (1, 'website', '{}', 'kept', 'reported');
		INSERT INTO campaigns (id) VALUES (1);
		INSERT INTO analysis_runs (id, submission_id, analysis_kind) VALUES (1, 1, 'website'), (2, 404, 'website');
		INSERT INTO artifacts (id, submission_id, kind, blob) VALUES (1, 1, 'screenshot', x''), (2, 404, 'screenshot', x''), (3, NULL, 'screenshot', x'');
		INSERT INTO abuse_reports (id, submission_id, campaign_id, tracking_token_hash, request_payload_hash, allegation_category, description) VALUES
			(1, 1, NULL, 'a', 'p', 'phishing', 'kept'),
			(2, 404, NULL, 'b', 'p', 'phishing', 'deleted case'),
			(3, NULL, 1, 'c', 'p', 'phishing', 'referral'),
			(4, NULL, 404, 'd', 'p', 'phishing', 'deleted campaign');
		INSERT INTO abuse_targets (id, report_id, ordinal, original_input, original_inputs, normalized_target, target_type) VALUES
			(1, 1, 0, 'kit.example', '[]', 'kit.example', 'domain'),
			(2, 2, 0, 'gone.example', '[]', 'gone.example', 'domain');
		INSERT INTO abuse_jobs (id, job_type, report_id, next_attempt_at) VALUES (1, 'resolve_report', 1, 0), (2, 'resolve_report', 2, 0);
		INSERT INTO abuse_events (id, report_id, target_id, job_id, event_type) VALUES
			(1, 1, 1, 1, 'kept'),
			(2, 1, 99, 404, 'discarded job and target'),
			(3, 2, NULL, NULL, 'deleted case');
	`);
	return database;
}

test("0032 settles every orphan as its foreign key's ON DELETE would have, keeping rows whose parents exist", () => {
	const database = databaseWithOrphans();
	expect(database.query("PRAGMA foreign_key_check").all().length).toBeGreaterThan(0);
	applyMigration(database, MIGRATION);

	expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
	expect(database.query("SELECT id FROM analysis_runs").all()).toEqual([{ id: 1n }]);
	// An artifact without a case is no orphan.
	expect(database.query("SELECT id FROM artifacts ORDER BY id").all()).toEqual([{ id: 1n }, { id: 3n }]);
	expect(database.query("SELECT id FROM abuse_reports ORDER BY id").all()).toEqual([{ id: 1n }, { id: 3n }]);
	// A deleted report's children go with it, down the chain.
	expect(database.query("SELECT id FROM abuse_targets").all()).toEqual([{ id: 1n }]);
	expect(database.query("SELECT id FROM abuse_jobs").all()).toEqual([{ id: 1n }]);
	// An event outlives its job and target: their ids are cleared.
	expect(database.query("SELECT id, target_id, job_id FROM abuse_events ORDER BY id").all()).toEqual([
		{ id: 1n, target_id: 1n, job_id: 1n },
		{ id: 2n, target_id: null, job_id: null },
	]);
});

test("0032 keeps every report column and index, and a campaign's delete now takes its referral", () => {
	const database = databaseWithOrphans();
	const columns = (db: Database) => db.query("SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('abuse_reports') ORDER BY name").all();
	const indexes = (db: Database) => db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'abuse_reports' AND sql IS NOT NULL ORDER BY name").all();
	const [columnsBefore, indexesBefore] = [columns(database), indexes(database)];
	const before = database.query("SELECT * FROM abuse_reports WHERE id IN (1, 3) ORDER BY id").all();
	applyMigration(database, MIGRATION);

	expect(columns(database)).toEqual(columnsBefore);
	expect(indexes(database)).toEqual(indexesBefore);
	expect(database.query("SELECT * FROM abuse_reports ORDER BY id").all()).toEqual(before);
	expect(database.query("SELECT \"table\", \"from\", on_delete FROM pragma_foreign_key_list('abuse_reports') ORDER BY \"from\"").all()).toEqual([
		{ table: "campaigns", from: "campaign_id", on_delete: "CASCADE" },
		{ table: "submissions", from: "submission_id", on_delete: "CASCADE" },
	]);

	database.exec("PRAGMA foreign_keys = ON");
	database.exec("DELETE FROM campaigns WHERE id = 1");
	expect(count(database, "abuse_reports")).toBe(1n);
});
