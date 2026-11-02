import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { sha256Hex } from "../../abuse/security";
import { containedSamplePath, sampleArchiveRelativePath, sanitizeRemoteFilename } from "./sample_paths";
import { isSampleExpired } from "./retention";
import { readProtectedArchive } from "./protected_archive";

/** Largest sample the investigation will keep; larger files are recorded by hash only. */
export const MAX_STORED_SAMPLE_BYTES = 100 * 1024 * 1024;

/**
 * The archive password is the convention malware repositories publish ("infected"),
 * which is what analysts' tools expect. Because it is public, the AES archive protects
 * bytes from casual browsing and accidental execution only. It does not keep a
 * determined reader out, and no secret is stored in it.
 */
export const SAMPLE_ARCHIVE_PASSWORD = "infected";
/** The fixed entry name inside every sample archive. */
export const SAMPLE_ENTRY_NAME = "sample.bin";

export type StoredSample = {
	sha256: string;
	sizeBytes: number;
	/** Sanitized remote name, kept only as metadata. */
	displayName: string;
	/** Path relative to the store root; never a file name taken from the remote side. */
	relativePath: string;
	storedAt: Date;
};

/**
 * Write a sample into its protected archive under `root`. The raw bytes are
 * written only inside the archive produced by `buildArchive`, through a temporary
 * file that is renamed into place, so an interrupted write never leaves a partial
 * archive under its final name.
 */
export async function storeSample(params: {
	root: string;
	bytes: Buffer;
	remoteName: string | undefined;
	now: Date;
	buildArchive(entryName: string, data: Buffer, password: string): Promise<Buffer>;
}): Promise<StoredSample> {
	if (!path.isAbsolute(params.root)) throw new Error("The sample store root must be an absolute path.");
	if (params.bytes.byteLength === 0) throw new Error("An empty download is not a sample.");
	if (params.bytes.byteLength > MAX_STORED_SAMPLE_BYTES) throw new Error("The sample exceeds the storage limit and is not kept.");
	const sha256 = createHash("sha256").update(params.bytes).digest("hex");
	const relativePath = sampleArchiveRelativePath(sha256);
	const finalPath = containedSamplePath(params.root, relativePath);
	const displayName = sanitizeRemoteFilename(params.remoteName);
	const archive = await params.buildArchive(SAMPLE_ENTRY_NAME, params.bytes, SAMPLE_ARCHIVE_PASSWORD);
	// The archive is stored only after it opens with the right password and yields the exact bytes
	// whose digest is recorded. A failed write must never leave a sample that looks valid.
	const verified = await readProtectedArchive(archive, SAMPLE_ARCHIVE_PASSWORD);
	if (sha256Hex(verified.data) !== sha256) throw new Error("The sample archive did not round-trip to the recorded digest.");
	await mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
	// The "wx" flag refuses to reuse an existing name; the random suffix keeps two
	// concurrent writers from ever choosing the same temporary file.
	const temporaryPath = `${finalPath}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		await writeFile(temporaryPath, archive, { mode: 0o600, flag: "wx" });
		await rename(temporaryPath, finalPath);
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
	return { sha256, sizeBytes: params.bytes.byteLength, displayName, relativePath, storedAt: params.now };
}

/** Whether a stored sample has outlived its retention window and should be removed. */
export function sampleIsExpired(sample: Pick<StoredSample, "storedAt">, now: Date, retentionMs: number): boolean {
	return isSampleExpired(sample.storedAt, now, retentionMs);
}
