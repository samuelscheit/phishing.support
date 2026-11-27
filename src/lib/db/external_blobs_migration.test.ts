import { expect, test } from "bun:test";

import { caseReportedAs } from "../submissions/finding";
import { submissionTitle } from "./entities/submissions";
import { applyMigration, databaseBefore } from "./migration_test_helpers";
import type { SubmissionData } from "./schema";

const MIGRATION = "0038_external_blobs_and_list_indexes";

const names = (rows: unknown[]) => (rows as Array<{ name: string }>).map((row) => row.name).sort();

test("0038 drops the inline blob columns, keeping every row, index and foreign key of both artifact tables", () => {
	// Foreign keys are off as in the migrator.
	const database = databaseBefore(MIGRATION);
	database.exec(`
		INSERT INTO submissions (id, kind, data, dedupe_key, status) VALUES (1, 'website', '{"kind":"website","website":{"url":"https://kit.example/"}}', 'one', 'reported');
		INSERT INTO artifacts (id, submission_id, name, kind, mime_type, sha256, size, blob, created_at, archived_at) VALUES
			(1, 1, 'website.png', 'website_png', 'image/png', '${"a".repeat(64)}', 3, x'010203', 1000, 900),
			(2, NULL, NULL, 'upload', NULL, NULL, NULL, x'', 2000, NULL);
		INSERT INTO abuse_reports (id, submission_id, tracking_token_hash, request_payload_hash, allegation_category, description) VALUES (1, 1, 't', 'p', 'phishing', 'd');
		INSERT INTO abuse_targets (id, report_id, ordinal, original_input, original_inputs, normalized_target, target_type) VALUES (1, 1, 0, 'kit.example', '[]', 'kit.example', 'domain');
		INSERT INTO abuse_provider_routes (id, report_id, target_id, route_key, provider_registry_key, provider_display_name, route_type, resolver_provenance, resolution_snapshot) VALUES (1, 1, 1, 'r', 'p', 'P', 'abuse_email', '{}', '{}');
		INSERT INTO abuse_artifacts (id, report_id, target_id, route_id, name, kind, mime_type, sha256, size, metadata, blob, created_at) VALUES (1, 1, 1, 1, 'raw.eml', 'raw_mail', 'message/rfc822', '${"b".repeat(64)}', 2, '{"a":1}', x'0102', 3000);
		INSERT INTO abuse_mail_messages (id, report_id, route_id, direction, kind, status, occurred_at, raw_artifact_id) VALUES (1, 1, 1, 'inbound', 'reply', 'received', 0, 1);
	`);
	applyMigration(database, MIGRATION);

	for (const table of ["artifacts", "abuse_artifacts"]) expect(names(database.query(`PRAGMA table_info(${table})`).all())).not.toContain("blob");
	expect(database.query("SELECT id, submission_id, name, kind, mime_type, sha256, size, created_at, archived_at FROM artifacts ORDER BY id").all()).toEqual([
		{ id: 1n, submission_id: 1n, name: "website.png", kind: "website_png", mime_type: "image/png", sha256: "a".repeat(64), size: 3n, created_at: 1000n, archived_at: 900n },
		// A row from before hashes were kept gets them from getDb() before the migration; on its own the migration still keeps it.
		{ id: 2n, submission_id: null, name: null, kind: "upload", mime_type: null, sha256: "", size: 0n, created_at: 2000n, archived_at: null },
	]);
	expect(database.query("SELECT id, report_id, target_id, route_id, run_id, name, sha256, size, metadata, created_at FROM abuse_artifacts").all()).toEqual([
		{ id: 1n, report_id: 1n, target_id: 1n, route_id: 1n, run_id: null, name: "raw.eml", sha256: "b".repeat(64), size: 2n, metadata: '{"a":1}', created_at: 3000n },
	]);
	const notNull = (table: string) => (database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: bigint }>).filter((column) => column.notnull === 1n).map((column) => column.name);
	expect(notNull("artifacts")).toEqual(expect.arrayContaining(["sha256", "size"]));

	const indexes = (table: string) => names(database.query(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${table}' AND name NOT LIKE 'sqlite_%'`).all());
	expect(indexes("artifacts")).toEqual(["artifacts_submission_kind_created_idx"]);
	expect(indexes("abuse_artifacts")).toEqual(["abuse_artifacts_report_kind_created_idx", "abuse_artifacts_report_sha_size_idx", "abuse_artifacts_run_idx"]);
	expect(indexes("analysis_runs")).toContain("analysis_runs_submission_created_idx");
	expect(indexes("submissions")).toEqual(expect.arrayContaining(["submissions_list_covering_idx", "submissions_status_created_id_idx", "submissions_id_site_group_idx"]));
	const keys = (table: string) => (database.query(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string; from: string; on_delete: string }>).map((key) => `${key.from}->${key.table} ${key.on_delete}`).sort();
	expect(keys("artifacts")).toEqual(["submission_id->submissions CASCADE"]);
	expect(keys("abuse_artifacts")).toEqual(["report_id->abuse_reports CASCADE", "route_id->abuse_provider_routes SET NULL", "run_id->abuse_provider_runs SET NULL", "target_id->abuse_targets SET NULL"]);
	expect(keys("abuse_mail_messages")).toContain("raw_artifact_id->abuse_artifacts SET NULL");

	database.exec("PRAGMA foreign_keys = ON");
	expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
	// The rebuilt and altered tables' keys still act.
	database.exec("DELETE FROM abuse_artifacts WHERE id = 1");
	expect(database.query("SELECT raw_artifact_id FROM abuse_mail_messages").all()).toEqual([{ raw_artifact_id: null }]);
	database.exec("DELETE FROM submissions WHERE id = 1");
	expect(database.query("SELECT id FROM artifacts").all()).toEqual([{ id: 2n }]);
});

test("0038 names every case and says what it would be reported for, exactly as the entity does from then on", () => {
	const hop = { hopIndex: 0, judgedHopIndex: 0, evidenceQuote: "x" };
	const site = (finding: string) => ({ hops: [], siteAssessments: [{ ...hop, finding }] });
	const funnel = (finding: string) => ({ hops: [], funnel: { verdict: { finding }, extraction: {} } });
	const cases: Array<{ data: SubmissionData; dedupeKey: string }> = [
		{ data: { kind: "email", email: { subject: "Your account is locked" } as never }, dedupeKey: "mail-1" },
		{ data: { kind: "email", email: { subject: "" } as never }, dedupeKey: "mail-2" },
		{ data: { kind: "email" }, dedupeKey: "mail-3" },
		{ data: { kind: "website", website: { url: "https://plain.example/" } }, dedupeKey: "site-1" },
		{ data: { kind: "website", website: { url: "" } }, dedupeKey: "site-2" },
		{ data: { kind: "website", website: { url: "https://p.example/", routes: [site("benign"), site("phishing")] as never } }, dedupeKey: "site-3" },
		{ data: { kind: "website", website: { url: "https://m.example/", routes: [site("malware")] as never } }, dedupeKey: "site-4" },
		{ data: { kind: "website", website: { url: "https://pm.example/", routes: [site("phishing"), site("malware")] as never } }, dedupeKey: "site-5" },
		{ data: { kind: "website", website: { url: "https://f.example/", routes: [funnel("deceptive_funnel"), site("insufficient_evidence")] as never } }, dedupeKey: "site-6" },
		{ data: { kind: "website", website: { url: "https://n.example/", routes: [funnel("not_deceptive"), site("benign")] as never } }, dedupeKey: "site-7" },
		{ data: { kind: "website", website: { url: "https://pf.example/", routes: [{ ...funnel("deceptive_funnel"), ...site("phishing") }] as never } }, dedupeKey: "site-8" },
	];
	const database = databaseBefore(MIGRATION);
	const insert = database.prepare("INSERT INTO submissions (id, kind, data, dedupe_key, status) VALUES (?, ?, ?, ?, 'reported')");
	for (const [index, { data, dedupeKey }] of cases.entries()) insert.run(index + 1, data.kind, JSON.stringify(data), dedupeKey);
	applyMigration(database, MIGRATION);

	expect(database.query("SELECT title, reported_as FROM submissions ORDER BY id").all()).toEqual(
		cases.map(({ data, dedupeKey }) => ({ title: submissionTitle(data, dedupeKey), reported_as: caseReportedAs(data) ?? null })),
	);
	// The cases cover every answer.
	expect(new Set(cases.map(({ data }) => caseReportedAs(data) ?? null))).toEqual(new Set(["phishing", "malware", "phishing_and_malware", "deceptive_funnel", null]));
});
