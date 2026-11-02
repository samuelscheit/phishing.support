/**
 * A structural read of a Windows PE file's Authenticode certificate table. It
 * reads bytes only: nothing is mapped, loaded, or executed, and every offset and
 * size is checked against the file length before it is used.
 *
 * This is a signal, not a verifier. It reports whether a certificate table is
 * present and how large it is. It does not validate the signature chain, so it
 * cannot prove a file is trustworthy. The upload gate uses it only to avoid
 * sending a file that looks like a signed installer to a public service.
 */

const DOS_MAGIC = 0x5a4d; // "MZ"
const PE_MAGIC = 0x00004550; // "PE\0\0"
const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;
/** Index of IMAGE_DIRECTORY_ENTRY_SECURITY in the optional header's data-directory array. */
const CERTIFICATE_TABLE_INDEX = 4;
const DATA_DIRECTORY_SIZE = 8;

export type PeCertificateState =
	| { kind: "not_pe" }
	| { kind: "malformed"; reason: string }
	| { kind: "unsigned" }
	| { kind: "certificate_table"; offset: number; size: number };

export function readPeCertificateTable(bytes: Buffer): PeCertificateState {
	if (bytes.byteLength < 0x40 || bytes.readUInt16LE(0) !== DOS_MAGIC) return { kind: "not_pe" };
	const peOffset = bytes.readUInt32LE(0x3c);
	if (peOffset + 24 > bytes.byteLength || bytes.readUInt32LE(peOffset) !== PE_MAGIC) return { kind: "malformed", reason: "missing PE signature" };
	const optionalOffset = peOffset + 24;
	const magic = bytes.readUInt16LE(optionalOffset);
	if (magic !== PE32_MAGIC && magic !== PE32_PLUS_MAGIC) return { kind: "malformed", reason: "unknown optional header magic" };
	// NumberOfRvaAndSizes and the data directories sit at different offsets in PE32 and PE32+.
	const countOffset = optionalOffset + (magic === PE32_MAGIC ? 92 : 108);
	const directoriesOffset = optionalOffset + (magic === PE32_MAGIC ? 96 : 112);
	if (countOffset + 4 > bytes.byteLength) return { kind: "malformed", reason: "truncated optional header" };
	const directoryCount = bytes.readUInt32LE(countOffset);
	if (directoryCount <= CERTIFICATE_TABLE_INDEX) return { kind: "unsigned" };
	const entryOffset = directoriesOffset + CERTIFICATE_TABLE_INDEX * DATA_DIRECTORY_SIZE;
	if (entryOffset + DATA_DIRECTORY_SIZE > bytes.byteLength) return { kind: "malformed", reason: "truncated data directory" };
	// For the certificate table, VirtualAddress is a file offset, not a relative virtual address.
	const offset = bytes.readUInt32LE(entryOffset);
	const size = bytes.readUInt32LE(entryOffset + 4);
	if (offset === 0 || size === 0) return { kind: "unsigned" };
	if (offset + size > bytes.byteLength || size < 8) return { kind: "malformed", reason: "certificate table outside the file" };
	return { kind: "certificate_table", offset, size };
}

/**
 * The policy's signature state for a file's bytes. A file that is not a PE, or a PE
 * with no certificate table, is not a signed installer. A signed PE is `signed_binary`.
 * A malformed PE fails closed as `unknown`, so it can never be uploaded on a parser error.
 */
export function signatureStateOf(bytes: Buffer): "not_signed" | "signed_binary" | "unknown" {
	const certificate = readPeCertificateTable(bytes);
	if (certificate.kind === "unsigned" || certificate.kind === "not_pe") return "not_signed";
	if (certificate.kind === "certificate_table") return "signed_binary";
	return "unknown";
}
