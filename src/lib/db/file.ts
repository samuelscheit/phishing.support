/** The SQLite database every connection of this process opens: `DB_FILE_NAME`. */
export function databaseFileName(): string {
	const fileName = process.env.DB_FILE_NAME;
	if (!fileName) throw new Error("DB_FILE_NAME must be configured before the database is used.");
	return fileName;
}

/** Whether `fileName` is a database file on disk, not `:memory:` or a `file:` URI (which tests use for private in-memory databases). */
export function isDiskDatabase(fileName: string): boolean {
	return fileName !== ":memory:" && !fileName.startsWith("file:");
}
