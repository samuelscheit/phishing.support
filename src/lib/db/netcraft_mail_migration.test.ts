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

function applyMigration(database: Database, name: string) {
	const source = readFileSync(join(migrationFolder, name), "utf-8");
	for (const statement of source.split("--> statement-breakpoint")) {
		if (statement.trim()) database.exec(statement);
	}
}

test("Netcraft mail migration preserves historical provider reports and enforces one durable operation key", () => {
	const directory = mkdtempSync(join(tmpdir(), "phishing-reporter-netcraft-migration-"));
	temporaryDirectories.push(directory);
	const database = new Database(join(directory, "migration.sqlite"), { safeIntegers: true });

	for (const migration of [
		"0000_amused_kat_farrell.sql",
		"0001_workable_shen.sql",
		"0002_add_reporter_metadata.sql",
		"0003_add_artifact_archive_date.sql",
		"0004_per_report_reply_identities.sql",
		"0005_correspondence_integrity.sql",
		"0006_standalone_abuse_reporting.sql",
	]) {
		applyMigration(database, migration);
	}

	database
		.query(`INSERT INTO submissions (id, kind, data, dedupe_key, status, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`)
		.run(1n, "email", JSON.stringify({ kind: "email" }), "netcraft-migration", "reported", 1n, 1n);
	database
		.query(`INSERT INTO provider_reports (id, submission_id, channel, "to", body, status, legacy, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.run(2n, 1n, "legacy", "Legacy provider", "Historical report", "sent", 1, 2n, 2n);

	applyMigration(database, "0007_netcraft_mail_reporting.sql");

	const columns = database.query("PRAGMA table_info(provider_reports)").all() as Array<{ name: string }>;
	expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["operation_key", "provider_submission_url", "error"]));
	const [legacy] = database.query("SELECT operation_key, provider_submission_url, error FROM provider_reports WHERE id = 2").all() as Array<Record<string, unknown>>;
	expect(legacy).toEqual({ operation_key: null, provider_submission_url: null, error: null });

	database
		.query(`INSERT INTO provider_reports (id, submission_id, channel, operation_key, "to", body, status, legacy, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.run(3n, 1n, "netcraft_mail_v3", "netcraft:mail:1", "Netcraft", "Mail report", "submission_started", 0, 3n, 3n);
	expect(() => database
		.query(`INSERT INTO provider_reports (id, submission_id, channel, operation_key, "to", body, status, legacy, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.run(4n, 1n, "netcraft_mail_v3", "netcraft:mail:1", "Netcraft", "Duplicate", "pending", 0, 4n, 4n))
		.toThrow();

	database.close();
});
