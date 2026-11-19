import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const migrationFolder = join(process.cwd(), "drizzle");
const journal = JSON.parse(readFileSync(join(migrationFolder, "meta", "_journal.json"), "utf-8")) as { entries: Array<{ tag: string }> };
const MIGRATION = "0020_campaign_visitor_guidance";
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Run one migration as Drizzle's migrator does: in a transaction, where its foreign_keys pragma does nothing. */
function applyMigration(database: Database, tag: string) {
	database.exec("BEGIN");
	for (const statement of readFileSync(join(migrationFolder, `${tag}.sql`), "utf-8").split("--> statement-breakpoint")) {
		if (statement.trim()) database.exec(statement);
	}
	database.exec("COMMIT");
}

test("0020 adds the visitor guidance and blank-capture columns and leaves every existing row as it was", () => {
	const directory = mkdtempSync(join(tmpdir(), "phishing-reporter-visitor-migration-"));
	temporaryDirectories.push(directory);
	const database = new Database(join(directory, "campaign.sqlite"), { safeIntegers: true });
	const index = journal.entries.findIndex((entry) => entry.tag === MIGRATION);
	expect(index).toBeGreaterThan(0);
	for (const entry of journal.entries.slice(0, index)) applyMigration(database, entry.tag);

	database.exec(`
		INSERT INTO submissions (id, kind, data, dedupe_key, status, created_at, updated_at) VALUES (1, 'website', '{"kind":"website","website":{"url":"https://samtjo.com/"}}', 'samtjo.com', 'reported', 10, 11);
		INSERT INTO campaigns (id, title, summary, summary_site_count) VALUES (5, 'Fake notice', 'Summary', 1);
		INSERT INTO campaign_members (submission_id, campaign_id) VALUES (1, 5);
		INSERT INTO campaign_site_facts (submission_id, language, thumbnail_artifact_id) VALUES (1, 'en', 9);
		INSERT INTO campaign_indicators (id, submission_id, kind, value, links, evidence) VALUES (3, 1, 'operator_server', 'telegram-bot:1', 1, '{}');
	`);
	applyMigration(database, MIGRATION);

	expect(database.query("SELECT CAST(id AS TEXT) AS id, dedupe_key, status, data FROM submissions").all()).toEqual([
		{ id: "1", dedupe_key: "samtjo.com", status: "reported", data: '{"kind":"website","website":{"url":"https://samtjo.com/"}}' },
	]);
	expect(database.query("SELECT COUNT(*) AS count FROM campaign_members").get()).toEqual({ count: 1n });
	expect(database.query("SELECT COUNT(*) AS count FROM campaign_indicators").get()).toEqual({ count: 1n });
	expect(database.query("SELECT language, thumbnail_artifact_id, blank_capture FROM campaign_site_facts").get()).toEqual({ language: "en", thumbnail_artifact_id: 9n, blank_capture: 0n });
	expect(database.query("SELECT title, visitor_guidance FROM campaigns").get()).toEqual({ title: "Fake notice", visitor_guidance: null });
	// A site linked after the migration starts as not blank until its capture is read.
	database.exec("INSERT INTO campaign_site_facts (submission_id) VALUES (1) ON CONFLICT DO NOTHING");
	expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
