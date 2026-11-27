import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import { sha256Hex } from "../util/hash";
import { databaseFileName, isDiskDatabase } from "./file";

/**
 * The bytes of `artifacts` and `abuse_artifacts`, stored by their SHA-256
 * next to the database (`<db dir>/blobs/ab/cd/abcd…`) instead of inside it:
 * a row keeps the hash and size, the file the bytes. Identical bytes are one
 * file. A database that lives in memory keeps its blobs in memory too.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;

const memoryBlobs = new Map<string, Buffer>();

/** Forget the in-memory blobs; `resetDatabaseForTesting` calls it with the database it closes. */
export function resetBlobStoreForTesting(): void {
	memoryBlobs.clear();
}

/** The directory the blobs of the database `fileName` live in; undefined for an in-memory database. */
export function blobDirectory(fileName: string = databaseFileName()): string | undefined {
	return isDiskDatabase(fileName) ? join(dirname(fileName), "blobs") : undefined;
}

function checkedHash(sha256: string): string {
	if (!SHA256_HEX.test(sha256)) throw new Error(`"${sha256}" is not a lowercase hex SHA-256.`);
	return sha256;
}

function pathIn(directory: string, sha256: string): string {
	return join(directory, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

/** Where the blob `sha256` of the database `fileName` is stored on disk. */
export function blobFilePath(sha256: string, fileName: string = databaseFileName()): string {
	const directory = blobDirectory(fileName);
	if (!directory) throw new Error(`The database ${fileName} keeps its blobs in memory, not on disk.`);
	return pathIn(directory, checkedHash(sha256));
}

function sizeOnDisk(path: string): number | undefined {
	try {
		return statSync(path).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Write `buffer` to `path` whole or not at all: a temp file beside it, flushed, then renamed over it. */
function writeAtomically(path: string, buffer: Buffer): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = join(dirname(path), `.${path.slice(-64)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
	try {
		const fd = openSync(temp, "wx");
		try {
			let written = 0;
			while (written < buffer.byteLength) written += writeSync(fd, buffer, written, buffer.byteLength - written);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/**
 * Store `buffer` under its SHA-256 for the database `fileName`; a blob with
 * those bytes stored already is kept, only touched, so the orphan sweep
 * (`compactDatabaseStorage`) sees it as new. Call it before the row naming
 * the hash is written, so no row ever names a blob that is not there.
 */
export function writeBlob(buffer: Buffer, fileName: string = databaseFileName()): { sha256: string; size: number } {
	const sha256 = sha256Hex(buffer);
	const size = buffer.byteLength;
	const directory = blobDirectory(fileName);
	if (!directory) {
		if (!memoryBlobs.has(sha256)) memoryBlobs.set(sha256, Buffer.from(buffer));
		return { sha256, size };
	}
	const path = pathIn(directory, sha256);
	let reused = false;
	if (sizeOnDisk(path) === size) {
		try {
			const now = new Date();
			utimesSync(path, now, now);
			reused = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	if (!reused) writeAtomically(path, buffer);
	return { sha256, size };
}

/**
 * The stored bytes of blob `sha256`, as they are: a caller that must trust
 * them compares their hash with the one its row names. Throws when the blob
 * is missing.
 */
export function readBlob(sha256: string, fileName: string = databaseFileName()): Buffer {
	checkedHash(sha256);
	const directory = blobDirectory(fileName);
	if (!directory) {
		const stored = memoryBlobs.get(sha256);
		if (!stored) throw new Error(`Blob ${sha256} is missing from the in-memory blob store.`);
		return Buffer.from(stored);
	}
	const path = pathIn(directory, sha256);
	try {
		return readFileSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Blob ${sha256} is missing: ${path} does not exist.`, { cause: error });
		throw error;
	}
}

const INLINE_BLOB_TABLES = ["artifacts", "abuse_artifacts"] as const;

function hasInlineBlobColumn(client: Database, table: string): boolean {
	return (client.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((column) => column.name === "blob");
}

function asBuffer(value: Uint8Array | null): Buffer {
	if (!value) return Buffer.alloc(0);
	return Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/**
 * Move the bytes a database from before migration 0038 keeps inline
 * (`artifacts.blob`, `abuse_artifacts.blob`) into the blob store, so 0038 can
 * drop those columns. Rows are streamed one at a time: the inline blobs may be
 * far larger than memory. A row whose hash or size is missing or does not
 * match its bytes is given those of its bytes, so the row names the blob it
 * holds. Safe to run again after an interruption: written blobs are kept.
 */
export function extractInlineBlobsBeforeMigration(client: Database, fileName: string): { artifacts: number; abuseArtifacts: number; bytes: number } {
	const moved = { artifacts: 0, abuseArtifacts: 0, bytes: 0 };
	const directory = blobDirectory(fileName);
	for (const table of INLINE_BLOB_TABLES) {
		if (!hasInlineBlobColumn(client, table)) continue;
		const corrections: Array<{ id: bigint; sha256: string; size: number; stored: string | null }> = [];
		const rows = client.query<{ id: bigint; sha256: string | null; size: bigint | number | null; blob: Uint8Array | null }, []>(`SELECT id, sha256, size, blob FROM ${table}`);
		for (const row of rows.iterate()) {
			const { sha256, size } = writeBlob(asBuffer(row.blob), fileName);
			if (directory && sizeOnDisk(pathIn(directory, sha256)) !== size) throw new Error(`Blob ${sha256} of ${table} ${row.id} was not stored with its ${size} bytes.`);
			if (row.sha256 !== sha256 || row.size === null || Number(row.size) !== size) corrections.push({ id: row.id, sha256, size, stored: row.sha256 });
			if (table === "artifacts") moved.artifacts++;
			else moved.abuseArtifacts++;
			moved.bytes += size;
		}
		const mismatched = corrections.filter((correction) => correction.stored);
		if (mismatched.length > 0) console.warn(`${table}: ${mismatched.length} row(s) named a hash their bytes do not have and now name their bytes' hash: ${mismatched.map((correction) => `${correction.id} (${correction.stored} → ${correction.sha256})`).join(", ")}`);
		const correct = client.prepare(`UPDATE ${table} SET sha256 = ?, size = ? WHERE id = ?`);
		client.transaction(() => {
			for (const correction of corrections) correct.run(correction.sha256, correction.size, correction.id);
		})();
	}
	if (moved.artifacts + moved.abuseArtifacts > 0) {
		console.log(`Moved ${moved.artifacts} artifact and ${moved.abuseArtifacts} abuse artifact blob(s), ${moved.bytes} bytes, out of SQLite into ${directory ?? "memory"}.`);
	}
	return moved;
}
