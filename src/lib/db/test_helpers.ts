import { afterAll, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { blobFilePath } from "./blobs";
import { resetDatabaseForTesting } from "./index";

/** Replace the stored bytes of blob `sha256` on disk, as corruption or tampering would; every artifact naming it reads them. */
export function tamperBlob(sha256: string, bytes: Buffer): void {
	writeFileSync(blobFilePath(sha256), bytes);
}

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
