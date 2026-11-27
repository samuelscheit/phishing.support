import { mkdirSync } from "node:fs";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { SQLiteTransaction } from "drizzle-orm/sqlite-core";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { extractInlineBlobsBeforeMigration, resetBlobStoreForTesting } from "./blobs";
import { databaseFileName, isDiskDatabase } from "./file";
/**
 * This application has several independently bundled server entry points
 * (the custom server, Next route handlers, and background listeners). Each
 * can open the same SQLite file, so the connection must be configured for
 * concurrent readers and short competing writes before migrations or normal
 * queries begin.
 */
const SQLITE_BUSY_TIMEOUT_MS = 10_000;
/** Page cache per connection, in KiB (SQLite reads a negative `cache_size` as KiB): 64 MB. */
const SQLITE_CACHE_KIB = 64_000;
/** How much of a database file a connection maps into memory instead of reading it: 256 MB. */
const SQLITE_MMAP_BYTES = 256 * 1024 * 1024;

function configureSqlite(client: Database, fileName: string) {
	// WAL prevents readers from blocking the abuse worker while a submission
	// page is being rendered. `busy_timeout` lets short write races resolve
	// instead of immediately dropping durable jobs with SQLITE_BUSY. The cache,
	// memory-held temp tables and the memory map keep list and page reads off
	// the disk.
	client.exec(`
		PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		PRAGMA cache_size = -${SQLITE_CACHE_KIB};
		PRAGMA temp_store = MEMORY;
	`);
	if (isDiskDatabase(fileName)) client.exec(`PRAGMA mmap_size = ${SQLITE_MMAP_BYTES};`);
}

async function initializeDatabase() {
	const fileName = databaseFileName();
	if (isDiskDatabase(fileName)) mkdirSync(dirname(fileName), { recursive: true });
	const client = new Database(fileName, {
		safeIntegers: true,
	});
	configureSqlite(client, fileName);
	// Migration 0038 drops the inline blob columns: their bytes go to the blob store first.
	extractInlineBlobsBeforeMigration(client, fileName);

	const db = drizzle(
		client,
		{
			logger: false,
		}
	);

	await migrate(db, {
		migrationsFolder: join(process.cwd(), "drizzle"),
	});
	// Enforce every REFERENCES and its ON DELETE from here on. Only after the
	// migrations: they rebuild tables by DROP and RENAME, which with foreign
	// keys on would cascade-delete the children (the pragma is a no-op inside
	// the migrator's transaction, so a migration cannot switch it off itself).
	client.exec("PRAGMA foreign_keys = ON");

	return db;
}

let databasePromise: ReturnType<typeof initializeDatabase> | undefined;

type AppDatabase = Awaited<ReturnType<typeof initializeDatabase>>;
/** The transaction `db.transaction` hands its callback: what persistence helpers that run inside one write take. */
export type Transaction = SQLiteTransaction<"sync", void, Record<string, never>, ExtractTablesWithRelations<Record<string, never>>>;
/** Either: for a helper that works inside a transaction or on its own. */
export type DbExecutor = AppDatabase | Transaction;

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
	resetBlobStoreForTesting();
	if (!activeDatabase) return;

	try {
		(await activeDatabase).$client.close();
	} catch {
		// Tests may reset after a failed database initialization.
	}
}
