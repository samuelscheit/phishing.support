import { afterAll, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resetDatabaseForTesting } from "./index";

/**
 * Gives a test file a private, fully migrated SQLite database. This is kept
 * outside production code paths so database tests can never fall back to the
 * developer's configured DB_FILE_NAME.
 */
export function useTemporaryDatabase() {
	const directory = mkdtempSync(join(tmpdir(), "phishing-reporter-test-"));
	const fileName = join(directory, "test.sqlite");
	const originalFileName = process.env.DB_FILE_NAME;

	beforeEach(async () => {
		await resetDatabaseForTesting();
		rmSync(directory, { recursive: true, force: true });
		mkdirSync(directory, { recursive: true });
		process.env.DB_FILE_NAME = fileName;
	});

	afterAll(async () => {
		await resetDatabaseForTesting();
		if (originalFileName === undefined) delete process.env.DB_FILE_NAME;
		else process.env.DB_FILE_NAME = originalFileName;
		rmSync(directory, { recursive: true, force: true });
	});

	return { fileName };
}
