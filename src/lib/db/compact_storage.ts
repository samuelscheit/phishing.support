import type { Database } from "bun:sqlite";
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { blobDirectory } from "./blobs";
import { stripInputImages } from "./entities/analysis_runs";
import { databaseFileName, isDiskDatabase } from "./file";
import { getDb } from "./index";

const BATCH_SIZE = 50;
/** A blob younger than this may belong to a row still being written (blobs are stored before their rows). */
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

export type StorageCompaction = {
	/** Analysis runs whose stored input lost the screenshots it carried. */
	runsCompacted: number;
	/** Bytes of run input those screenshots took. */
	inputBytesFreed: number;
	/** Blob files no artifact names any more, removed. */
	orphanBlobsRemoved: number;
	orphanBytesRemoved: number;
	databaseBytesBefore: number;
	databaseBytesAfter: number;
};

/** The database file with its WAL; 0 for an in-memory database. */
function databaseBytes(fileName: string): number {
	if (!isDiskDatabase(fileName)) return 0;
	return [fileName, `${fileName}-wal`].reduce((total, path) => {
		try {
			return total + statSync(path).size;
		} catch {
			return total;
		}
	}, 0);
}

/** Strip the screenshots runs stored before inputs were stripped on write (`stripInputImages`). */
function compactRunInputs(client: Database): { runsCompacted: number; inputBytesFreed: number } {
	const batch = client.query<{ id: bigint; input: string }, [bigint]>(
		`SELECT id, input FROM analysis_runs
		WHERE input IS NOT NULL AND (instr(input, '"input_image"') > 0 OR instr(input, 'data:image/') > 0) AND id > ?
		ORDER BY id LIMIT ${BATCH_SIZE}`,
	);
	const update = client.prepare<void, [string, bigint]>("UPDATE analysis_runs SET input = ? WHERE id = ?");
	let runsCompacted = 0;
	let inputBytesFreed = 0;
	let after = -(2n ** 63n);
	for (;;) {
		const rows = batch.all(after);
		if (rows.length === 0) break;
		client.transaction(() => {
			for (const row of rows) {
				const stripped = JSON.stringify(stripInputImages(JSON.parse(row.input)));
				if (stripped === row.input) continue;
				update.run(stripped, row.id);
				runsCompacted++;
				inputBytesFreed += Buffer.byteLength(row.input) - Buffer.byteLength(stripped);
			}
		})();
		after = rows.at(-1)!.id;
	}
	return { runsCompacted, inputBytesFreed };
}

/** Every blob file under `directory`, two levels deep as `writeBlob` lays them out; temp files included. */
function* blobFiles(directory: string): Generator<{ name: string; path: string }> {
	const entries = (path: string) => {
		try {
			return readdirSync(path, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	};
	for (const first of entries(directory)) {
		if (!first.isDirectory()) continue;
		for (const second of entries(join(directory, first.name))) {
			if (!second.isDirectory()) continue;
			const parent = join(directory, first.name, second.name);
			for (const file of entries(parent)) if (file.isFile()) yield { name: file.name, path: join(parent, file.name) };
		}
	}
}

/**
 * Remove blob files (and abandoned temp files) older than `minAgeMs` that no
 * artifact names. The old files are listed before the names are read, and
 * each is checked again before it goes: `writeBlob` touches a blob it finds
 * stored already, so one a new row is about to name is never old.
 */
function removeOrphanBlobs(client: Database, directory: string, minAgeMs: number): { orphanBlobsRemoved: number; orphanBytesRemoved: number } {
	const cutoff = Date.now() - minAgeMs;
	const old = [...blobFiles(directory)].filter((file) => statSync(file.path).mtimeMs <= cutoff);
	const referenced = new Set(
		client.query<{ sha256: string }, []>("SELECT sha256 FROM artifacts UNION SELECT sha256 FROM abuse_artifacts").all().map((row) => row.sha256),
	);
	let orphanBlobsRemoved = 0;
	let orphanBytesRemoved = 0;
	for (const file of old) {
		if (referenced.has(file.name)) continue;
		const stats = statSync(file.path, { throwIfNoEntry: false });
		if (!stats || stats.mtimeMs > cutoff) continue;
		rmSync(file.path, { force: true });
		orphanBlobsRemoved++;
		orphanBytesRemoved += stats.size;
	}
	return { orphanBlobsRemoved, orphanBytesRemoved };
}

/**
 * Shrink what the database keeps on disk: strip the screenshots older
 * analysis runs stored in their input, remove blob files no artifact names
 * any more (older than `minAgeMs`, an hour by default), then checkpoint the
 * WAL and VACUUM so SQLite hands the freed pages back to the file system.
 * VACUUM needs about the database's size free on disk and blocks writers
 * while it runs: run it at a quiet time.
 */
export async function compactDatabaseStorage(options: { minAgeMs?: number } = {}): Promise<StorageCompaction> {
	const fileName = databaseFileName();
	const client = (await getDb()).$client;
	const databaseBytesBefore = databaseBytes(fileName);

	const runs = compactRunInputs(client);
	const directory = blobDirectory(fileName);
	const orphans = directory ? removeOrphanBlobs(client, directory, options.minAgeMs ?? ORPHAN_MIN_AGE_MS) : { orphanBlobsRemoved: 0, orphanBytesRemoved: 0 };
	if (isDiskDatabase(fileName)) {
		// VACUUM rebuilds the whole database in temp storage; keep that on disk rather than RAM.
		client.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		client.exec("PRAGMA temp_store = FILE");
		try {
			client.exec("VACUUM");
		} finally {
			client.exec("PRAGMA temp_store = MEMORY");
		}
		client.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	}

	const result = { ...runs, ...orphans, databaseBytesBefore, databaseBytesAfter: databaseBytes(fileName) };
	console.log(
		`Storage compacted: ${result.runsCompacted} analysis run(s) lost ${result.inputBytesFreed} bytes of inlined screenshots; `
		+ `${result.orphanBlobsRemoved} orphan blob(s), ${result.orphanBytesRemoved} bytes, removed; `
		+ `database ${result.databaseBytesBefore} → ${result.databaseBytesAfter} bytes.`,
	);
	return result;
}

if (import.meta.main) await compactDatabaseStorage();
