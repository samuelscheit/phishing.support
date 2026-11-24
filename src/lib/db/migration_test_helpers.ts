import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migrationFolder = join(process.cwd(), "drizzle");
const journal = JSON.parse(readFileSync(join(migrationFolder, "meta", "_journal.json"), "utf-8")) as { entries: Array<{ tag: string }> };

/** Run one migration as Drizzle's migrator does: in a transaction, where its foreign_keys pragma does nothing. */
export function applyMigration(database: Database, tag: string): void {
	database.exec("BEGIN");
	for (const statement of readFileSync(join(migrationFolder, `${tag}.sql`), "utf-8").split("--> statement-breakpoint")) {
		if (statement.trim()) database.exec(statement);
	}
	database.exec("COMMIT");
}

/** A new in-memory database with every migration before `tag` applied, for a test of `tag` on the rows it meets. */
export function databaseBefore(tag: string): Database {
	const index = journal.entries.findIndex((entry) => entry.tag === tag);
	if (index < 1) throw new Error(`Migration ${tag} is not in the journal.`);
	const database = new Database(":memory:", { safeIntegers: true });
	for (const entry of journal.entries.slice(0, index)) applyMigration(database, entry.tag);
	return database;
}
