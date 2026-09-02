import { mkdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { config } from "dotenv";

/**
 * This application has several independently bundled server entry points
 * (the custom server, Next route handlers, and background listeners). Each
 * can open the same SQLite file, so the connection must be configured for
 * concurrent readers and short competing writes before migrations or normal
 * queries begin.
 */
const SQLITE_BUSY_TIMEOUT_MS = 10_000;

function configureSqlite(client: Database) {
	// WAL prevents readers from blocking the abuse worker while a submission
	// page is being rendered. `busy_timeout` lets short write races resolve
	// instead of immediately dropping durable jobs with SQLITE_BUSY.
	client.exec(`
		PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
	`);
}

config({
	path: join(process.cwd(), ".env"),
	quiet: true,
});

function databaseFileName() {
	const fileName = process.env.DB_FILE_NAME;
	if (!fileName) throw new Error("DB_FILE_NAME must be configured before the database is used.");
	return fileName;
}

function ensureDatabaseDirectory(fileName: string) {
	if (fileName === ":memory:" || fileName.startsWith("file:")) return;
	mkdirSync(dirname(fileName), { recursive: true });
}

async function initializeDatabase() {
	const fileName = databaseFileName();
	ensureDatabaseDirectory(fileName);
	const client = new Database(fileName, {
		safeIntegers: true,
	});
	configureSqlite(client);

	const db = drizzle(
		client,
		{
			logger: false,
		}
	);

	await migrate(db, {
		migrationsFolder: join(process.cwd(), "drizzle"),
	});

	return db;
}

let databasePromise: ReturnType<typeof initializeDatabase> | undefined;

export function getDb() {
	databasePromise ??= initializeDatabase();
	return databasePromise;
}

/**
 * Closes the lazy SQLite connection so an isolated test can point DB_FILE_NAME
 * at a temporary database before the next getDb() call. Production code never
 * needs to reset this singleton.
 */
export async function resetDatabaseForTesting(): Promise<void> {
	const activeDatabase = databasePromise;
	databasePromise = undefined;
	if (!activeDatabase) return;

	try {
		(await activeDatabase).$client.close();
	} catch {
		// Tests may reset after a failed database initialization.
	}
}
