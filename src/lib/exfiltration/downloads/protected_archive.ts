/**
 * Password-protected, single-entry ZIP containers for malware samples.
 *
 * The container is written by `@zip.js/zip.js` with WinZip AES-256 (AE-2): the
 * sample bytes are encrypted and the entry name is fixed and non-revealing. The
 * previous hand-written ZipCrypto writer was removed: ZipCrypto is broken by a
 * known-plaintext attack (Biham and Kocher, 1994), so a sample it protected could
 * be recovered from a short run of known bytes.
 *
 * Analysts open an archive with a tool that supports AES ZIP. On macOS the system
 * `unzip` (Info-ZIP 6.00) does not, so use `bsdtar --passphrase <password> -x`.
 * The database stores each sample's SHA-256, and a sample is read back only
 * after its bytes match that digest.
 */
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";

/** The fixed entry name. It reveals nothing about the sample, so the archive never carries a remote filename. */
const ENTRY_NAME = "sample.bin";
const MAX_PASSWORD_BYTES = 255;
/** Samples are bounded so one archive can never exhaust memory during write or read. */
const MAX_SAMPLE_BYTES = 100 * 1024 * 1024;

export type ProtectedArchiveInput = { entryName: string; data: Buffer; password: string };

function assertPassword(password: string): void {
	if (!password) throw new Error("A protected archive needs a non-empty password.");
	if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES) throw new Error("A protected archive password is too long.");
}

/** Build an AES-256 archive holding one sample. The entry name must be the fixed name. */
export async function writeProtectedArchive(input: ProtectedArchiveInput): Promise<Buffer> {
	assertPassword(input.password);
	if (input.entryName !== ENTRY_NAME) throw new Error("A protected archive entry must use the fixed sample name.");
	if (input.data.byteLength > MAX_SAMPLE_BYTES) throw new Error("A sample exceeds the archive size limit.");
	const writer = new ZipWriter(new Uint8ArrayWriter());
	await writer.add(ENTRY_NAME, new Uint8ArrayReader(new Uint8Array(input.data)), {
		password: input.password,
		encryptionStrength: 3,
		zipCrypto: false,
	});
	return Buffer.from(await writer.close());
}

/**
 * Open an archive and return its sample. A wrong password, a damaged archive, or
 * a byte mismatch all throw; nothing is returned for an unverified sample.
 */
export async function readProtectedArchive(archive: Buffer, password: string): Promise<{ entryName: string; data: Buffer }> {
	assertPassword(password);
	const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(archive)));
	const entries = await reader.getEntries();
	if (entries.length !== 1) throw new Error("A protected archive must hold exactly one sample.");
	const [entry] = entries;
	// Only a file entry carries data; a directory entry or any other name is not a sample.
	if (!entry || entry.directory || !("getData" in entry) || entry.filename !== ENTRY_NAME || entry.zipCrypto) {
		throw new Error("Protected archive entry is not an AES sample.");
	}
	try {
		const data = Buffer.from(await entry.getData(new Uint8ArrayWriter(), { password }));
		return { entryName: entry.filename, data };
	} catch {
		// zip.js reports "Invalid password" both for a wrong password and for a damaged payload,
		// and exposes no separate code, so the two cases cannot be told apart here. Say that.
		throw new Error("Protected archive could not be opened: the password is wrong or the archive is damaged.");
	} finally {
		await reader.close();
	}
}
