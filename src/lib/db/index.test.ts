import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { getDb } from "./index";
import { useTemporaryDatabase } from "./test_helpers";

useTemporaryDatabase();

test("SQLite uses WAL and a busy timeout for concurrent server and worker access", async () => {
	const db = await getDb();
	const client = (db as unknown as { $client: Database }).$client;

	expect(client.query("PRAGMA journal_mode").get() as { journal_mode: string }).toEqual({ journal_mode: "wal" });
	expect(client.query("PRAGMA busy_timeout").get() as { timeout: bigint }).toEqual({ timeout: 10_000n });
});

test("the connection enforces foreign keys: no orphan is written and a delete cascades or clears", async () => {
	const db = await getDb();
	const client = (db as unknown as { $client: Database }).$client;
	expect(client.query("PRAGMA foreign_keys").get() as { foreign_keys: bigint }).toEqual({ foreign_keys: 1n });

	expect(() => client.run("INSERT INTO analysis_runs (id, submission_id, analysis_kind) VALUES (1, 404, 'website')")).toThrow("FOREIGN KEY constraint failed");

	client.run("INSERT INTO submissions (id, kind, data, dedupe_key, status) VALUES (1, 'website', '{}', 'one', 'failed')");
	client.run("INSERT INTO analysis_runs (id, submission_id, analysis_kind) VALUES (1, 1, 'website')");
	client.run("INSERT INTO abuse_reports (id, submission_id, tracking_token_hash, request_payload_hash, allegation_category, description) VALUES (1, 1, 't', 'p', 'phishing', 'd')");
	client.run("INSERT INTO abuse_jobs (id, job_type, report_id, next_attempt_at) VALUES (1, 'resolve_report', NULL, 0)");
	client.run("INSERT INTO abuse_events (id, report_id, job_id, event_type) VALUES (1, 1, 1, 'report.accepted')");

	// A job's delete keeps the report's event and clears its job (ON DELETE SET NULL).
	client.run("DELETE FROM abuse_jobs WHERE id = 1");
	expect(client.query("SELECT job_id FROM abuse_events").all()).toEqual([{ job_id: null }]);

	// A case's delete takes its runs, its report and the report's events with it (ON DELETE CASCADE).
	client.run("DELETE FROM submissions WHERE id = 1");
	for (const table of ["analysis_runs", "abuse_reports", "abuse_events"]) expect(client.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0n });
});
