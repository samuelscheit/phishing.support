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

/** Builds a populated pre-correspondence database from the actual old migrations. */
function createLegacyDatabase() {
	const directory = mkdtempSync(join(tmpdir(), "phishing-reporter-migration-test-"));
	temporaryDirectories.push(directory);
	const database = new Database(join(directory, "legacy.sqlite"), { safeIntegers: true });

	for (const entry of ["0000_amused_kat_farrell.sql", "0001_workable_shen.sql", "0002_add_reporter_metadata.sql", "0003_add_artifact_archive_date.sql"]) {
		applySqlMigration(database, entry);
	}

	database
		.query(
			`INSERT INTO submissions (id, kind, data, dedupe_key, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(1n, "website", JSON.stringify({ kind: "website", website: { url: "https://legacy.example.test" } }), "legacy-submission", "reported", 10n, 11n);
	database
		.query(
			`INSERT INTO reports (id, submission_id, analysis_run_id, channel, "to", subject, body, status, sent_at, provider_message_id, attachments_artifact_ids, data, created_at, updated_at)
			 VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			2n,
			1n,
			"email",
			"legacy-abuse@example.test",
			"Historical SMTP report",
			"Historical report body",
			"sent",
			12n,
			"legacy-provider-id",
			JSON.stringify([]),
			JSON.stringify({ historical: true }),
			13n,
			14n,
		);

	return database;
}

test("correspondence migration preserves legacy reports without fabricating report threads", () => {
	const database = createLegacyDatabase();
	try {
		// Apply only the correspondence migrations. This test must remain an
		// isolated preflight for a populated legacy database instead of silently
		// depending on unrelated migrations added later in the worktree.
		applySqlMigration(database, "0004_per_report_reply_identities.sql");
		applySqlMigration(database, "0005_correspondence_integrity.sql");

		const tableNames = database.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
		expect(tableNames.map((row) => row.name)).toEqual(
			expect.arrayContaining(["provider_reports", "report_threads", "report_messages", "mail_ingest"]),
		);
		expect(tableNames.map((row) => row.name)).not.toContain("reports");

		const [legacyReport] = database.query("SELECT * FROM provider_reports WHERE id = 2").all() as Array<Record<string, unknown>>;
		expect(legacyReport).toMatchObject({
			id: 2n,
			submission_id: 1n,
			channel: "email",
			to: "legacy-abuse@example.test",
			subject: "Historical SMTP report",
			body: "Historical report body",
			status: "sent",
			provider_message_id: "legacy-provider-id",
			legacy: 1n,
		});
		expect(database.query("SELECT count(*) AS count FROM report_threads").get()).toEqual({ count: 0n });
		expect(database.query("SELECT count(*) AS count FROM report_messages").get()).toEqual({ count: 0n });
		expect((database.query("PRAGMA table_info(report_messages)").all() as Array<{ name: string }>).map((column) => column.name)).toContain("sent_at");

		const indexes = database.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
		expect(indexes.map((row) => row.name)).toEqual(
			expect.arrayContaining([
				"report_threads_reply_address_unique",
				"report_threads_reply_token_unique",
				"report_messages_thread_occurred_idx",
				"report_messages_message_id_idx",
				"report_messages_in_reply_to_idx",
				"report_messages_outbound_message_id_unique",
				"report_messages_inbound_message_id_unique",
				"mail_ingest_mailbox_uid_unique",
			]),
		);
	} finally {
		database.close();
	}
});
