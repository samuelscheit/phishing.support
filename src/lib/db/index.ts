import { mkdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { config } from "dotenv";

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

	const db = drizzle(
		new Database(fileName, {
			safeIntegers: true,
		}),
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
