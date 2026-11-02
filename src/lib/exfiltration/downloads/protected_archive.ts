/**
 * Password-protected, single-entry ZIP containers for malware samples.
 *
 * The layout is the classic PKWARE format: one stored (uncompressed) entry encrypted with the
 * traditional "ZipCrypto" stream cipher. `unzip -P <password>` reads it.
 *
 * This is a sharing container, not strong encryption. ZipCrypto is broken: a known-plaintext attack
 * (Biham and Kocher, 1994) recovers its keys from a short run of known plaintext, so anyone who can
 * guess part of the sample can read all of it. Use this only to hand samples to tools that expect the
 * format. Never use it to protect secrets.
 */
import { randomBytes } from "node:crypto";

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const ENCRYPTION_HEADER_SIZE = 12;
const RANDOM_HEADER_SIZE = ENCRYPTION_HEADER_SIZE - 1;
const ENTRY_COUNT = 1;

/** Version 2.0 is the first that defines traditional encryption. */
const ZIP_VERSION = 20;
/** "Version made by" is the version alone: its high byte, the host system, is 0 (MS-DOS). */
const VERSION_MADE_BY = ZIP_VERSION;
const METHOD_STORED = 0;
/** Bit 0 marks the entry encrypted. Bit 3 (sizes and CRC after the data) is never written, so the flag word is exactly this. */
const FLAG_ENCRYPTED = 0x0001;
/** 00:00:00 on 1980-01-01, so the output does not depend on the clock. */
const FIXED_DOS_TIME = 0x0000;
const FIXED_DOS_DATE = 0x0021;

const MAX_DATA_BYTES = 100 * 1024 * 1024;
const MAX_PASSWORD_BYTES = 255;
const ENTRY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

const WRONG_PASSWORD_MESSAGE = "Protected archive could not be opened with the supplied password.";
const CORRUPT_MESSAGE = "Protected archive is corrupt.";
const PASSWORD_RULE_MESSAGE = "Protected archive password must be 1 to 255 UTF-8 bytes of well-formed text.";
const ENTRY_NAME_RULE_MESSAGE =
	"Protected archive entry name must be 1 to 100 ASCII letters, digits, '.', '_' or '-', start with a letter or digit, and contain no '..'.";
const DATA_RULE_MESSAGE = `Protected archive data must be a Buffer of at most ${MAX_DATA_BYTES} bytes.`;

/**
 * Returns a complete archive whose only entry holds `data`. Each call draws a fresh random
 * encryption header, so the same input never produces the same bytes.
 */
export function writeProtectedArchive(params: { entryName: string; data: Buffer; password: string }): Buffer {
	const { entryName, data, password } = params;
	if (!isValidEntryName(entryName)) throw new Error(ENTRY_NAME_RULE_MESSAGE);
	const passwordBytes = encodePassword(password);
	if (!Buffer.isBuffer(data) || data.length > MAX_DATA_BYTES) throw new Error(DATA_RULE_MESSAGE);

	const name = Buffer.from(entryName, "ascii");
	const crc = crc32(data);
	// Each value goes into a fixed-width field, so it is range-checked before anything is allocated.
	const fields: FileFields = {
		flags: FLAG_ENCRYPTED,
		method: METHOD_STORED,
		crc,
		compressedSize: checkedUInt(ENCRYPTION_HEADER_SIZE + data.length, UINT32_MAX),
		uncompressedSize: checkedUInt(data.length, UINT32_MAX),
		nameLength: checkedUInt(name.length, UINT16_MAX),
	};
	const payloadStart = LOCAL_HEADER_SIZE + name.length;
	const centralStart = checkedUInt(payloadStart + fields.compressedSize, UINT32_MAX);
	const centralSize = checkedUInt(CENTRAL_HEADER_SIZE + name.length, UINT32_MAX);
	const endStart = centralStart + centralSize;
	const archive = Buffer.alloc(endStart + END_OF_CENTRAL_DIRECTORY_SIZE);

	archive.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
	writeFileFields(archive, 4, fields);
	// The extra field length (offset 28) stays zero.
	name.copy(archive, LOCAL_HEADER_SIZE);

	// The encryption header and the data are one ZipCrypto stream, so they share a single key state.
	const encryptionHeader = Buffer.concat([randomBytes(RANDOM_HEADER_SIZE), Buffer.from([checkByte(crc)])]);
	const keys = createCipherKeys(passwordBytes);
	zipCrypt(keys, encryptionHeader, archive.subarray(payloadStart, payloadStart + ENCRYPTION_HEADER_SIZE), "encrypt");
	zipCrypt(keys, data, archive.subarray(payloadStart + ENCRYPTION_HEADER_SIZE, centralStart), "encrypt");

	archive.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, centralStart);
	archive.writeUInt16LE(VERSION_MADE_BY, centralStart + 4);
	writeFileFields(archive, centralStart + 6, fields);
	// The extra length, comment length, disk start, attributes and local header offset (0) stay zero.
	name.copy(archive, centralStart + CENTRAL_HEADER_SIZE);

	archive.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, endStart);
	archive.writeUInt16LE(ENTRY_COUNT, endStart + 8);
	archive.writeUInt16LE(ENTRY_COUNT, endStart + 10);
	archive.writeUInt32LE(centralSize, endStart + 12);
	archive.writeUInt32LE(centralStart, endStart + 16);
	// The archive comment length (offset 20) stays zero.
	return archive;
}

/**
 * Opens an archive written by `writeProtectedArchive`. A wrong password throws the generic
 * wrong-password error. Any structural or CRC failure throws the corruption error. Neither message
 * includes the password.
 */
export function readProtectedArchive(archive: Buffer, password: string): { entryName: string; data: Buffer } {
	const passwordBytes = encodePassword(password);
	const entry = parseEntry(archive);

	const keys = createCipherKeys(passwordBytes);
	const encryptionHeader = Buffer.alloc(ENCRYPTION_HEADER_SIZE);
	zipCrypt(keys, entry.encrypted.subarray(0, ENCRYPTION_HEADER_SIZE), encryptionHeader, "decrypt");
	// ZipCrypto's only password test is this 8-bit check byte. A wrong password passes it about 1 time in 256,
	// and the CRC check below then reports corruption instead.
	if (encryptionHeader[ENCRYPTION_HEADER_SIZE - 1] !== checkByte(entry.crc)) throw new Error(WRONG_PASSWORD_MESSAGE);

	const data = Buffer.alloc(entry.size);
	zipCrypt(keys, entry.encrypted.subarray(ENCRYPTION_HEADER_SIZE), data, "decrypt");
	requireValid(crc32(data) === entry.crc);
	return { entryName: entry.name, data };
}

type ParsedEntry = { name: string; crc: number; size: number; encrypted: Buffer };

/**
 * Accepts only the layout `writeProtectedArchive` produces: local header, payload, central directory
 * header and end record, back to back, with no extra fields or comments. Each offset is checked against
 * the archive length before any bytes at that offset are read.
 */
function parseEntry(archive: Buffer): ParsedEntry {
	requireValid(archive.length >= LOCAL_HEADER_SIZE + END_OF_CENTRAL_DIRECTORY_SIZE);

	const end = archive.length - END_OF_CENTRAL_DIRECTORY_SIZE;
	requireValid(archive.readUInt32LE(end) === END_OF_CENTRAL_DIRECTORY_SIGNATURE);
	// One disk, one entry, and no archive comment.
	requireValid(archive.readUInt16LE(end + 4) === 0 && archive.readUInt16LE(end + 6) === 0);
	requireValid(archive.readUInt16LE(end + 8) === ENTRY_COUNT && archive.readUInt16LE(end + 10) === ENTRY_COUNT);
	requireValid(archive.readUInt16LE(end + 20) === 0);
	const centralSize = archive.readUInt32LE(end + 12);
	const centralStart = archive.readUInt32LE(end + 16);
	requireValid(centralSize >= CENTRAL_HEADER_SIZE && centralStart + centralSize === end);

	requireValid(archive.readUInt32LE(0) === LOCAL_HEADER_SIGNATURE);
	const local = readFileFields(archive, 4);
	requireValid(archive.readUInt16LE(28) === 0);
	requireValid(isSupportedEntry(local));
	const payloadStart = LOCAL_HEADER_SIZE + local.nameLength;
	requireValid(payloadStart + local.compressedSize === centralStart);
	const name = archive.toString("latin1", LOCAL_HEADER_SIZE, payloadStart);
	requireValid(isValidEntryName(name));

	requireValid(archive.readUInt32LE(centralStart) === CENTRAL_HEADER_SIGNATURE);
	requireValid(sameFileFields(readFileFields(archive, centralStart + 6), local));
	// The extra length, comment length, disk start and local header offset (0) must be zero for the layout to hold.
	requireValid(archive.readUInt16LE(centralStart + 30) === 0 && archive.readUInt16LE(centralStart + 32) === 0);
	requireValid(archive.readUInt16LE(centralStart + 34) === 0 && archive.readUInt32LE(centralStart + 42) === 0);
	requireValid(centralSize === CENTRAL_HEADER_SIZE + local.nameLength);
	requireValid(archive.toString("latin1", centralStart + CENTRAL_HEADER_SIZE, end) === name);

	return { name, crc: local.crc, size: local.uncompressedSize, encrypted: archive.subarray(payloadStart, centralStart) };
}

/** The fields the local and central headers share, in the order they appear in both. */
type FileFields = {
	flags: number;
	method: number;
	crc: number;
	compressedSize: number;
	uncompressedSize: number;
	nameLength: number;
};

/** Writes the shared fields from the version-needed field on: offset 4 in a local header, 6 in a central one. */
function writeFileFields(header: Buffer, base: number, fields: FileFields): void {
	header.writeUInt16LE(ZIP_VERSION, base);
	header.writeUInt16LE(fields.flags, base + 2);
	header.writeUInt16LE(fields.method, base + 4);
	header.writeUInt16LE(FIXED_DOS_TIME, base + 6);
	header.writeUInt16LE(FIXED_DOS_DATE, base + 8);
	header.writeUInt32LE(fields.crc, base + 10);
	header.writeUInt32LE(fields.compressedSize, base + 14);
	header.writeUInt32LE(fields.uncompressedSize, base + 18);
	header.writeUInt16LE(fields.nameLength, base + 22);
}

function readFileFields(header: Buffer, base: number): FileFields {
	return {
		flags: header.readUInt16LE(base + 2),
		method: header.readUInt16LE(base + 4),
		crc: header.readUInt32LE(base + 10),
		compressedSize: header.readUInt32LE(base + 14),
		uncompressedSize: header.readUInt32LE(base + 18),
		nameLength: header.readUInt16LE(base + 22),
	};
}

/** The only entries this module reads: the flag word the writer produces, stored data, and consistent sizes. */
function isSupportedEntry(fields: FileFields): boolean {
	return (
		fields.flags === FLAG_ENCRYPTED &&
		fields.method === METHOD_STORED &&
		fields.uncompressedSize <= MAX_DATA_BYTES &&
		fields.compressedSize === ENCRYPTION_HEADER_SIZE + fields.uncompressedSize
	);
}

function sameFileFields(a: FileFields, b: FileFields): boolean {
	return (Object.keys(a) as Array<keyof FileFields>).every((key) => a[key] === b[key]);
}

function requireValid(condition: boolean): asserts condition {
	if (!condition) throw new Error(CORRUPT_MESSAGE);
}

function isValidEntryName(name: string): boolean {
	return typeof name === "string" && ENTRY_NAME_PATTERN.test(name) && !name.includes("..");
}

/** The password's UTF-8 bytes, which key the cipher. Writing and reading share this rule. */
function encodePassword(password: string): Buffer {
	// A lone surrogate has no UTF-8 form. Buffer would substitute U+FFFD, so two different passwords would collide.
	if (typeof password !== "string" || !password.isWellFormed()) throw new Error(PASSWORD_RULE_MESSAGE);
	const bytes = Buffer.from(password, "utf8");
	if (bytes.length === 0 || bytes.length > MAX_PASSWORD_BYTES) throw new Error(PASSWORD_RULE_MESSAGE);
	return bytes;
}

/** Returns `value` when it is an integer that fits a ZIP field `max` wide. */
function checkedUInt(value: number, max: number): number {
	if (!Number.isInteger(value) || value < 0 || value > max) {
		throw new RangeError("Protected archive header field is out of range.");
	}
	return value;
}

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let bit = 0; bit < 8; bit++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
}

/** Advances a reflected CRC-32 register by one byte. Callers apply the initial and final inversion. */
function crc32Step(crc: number, byte: number): number {
	return ((crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]) >>> 0;
}

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) crc = crc32Step(crc, data[i]);
	return (crc ^ 0xffffffff) >>> 0;
}

/** With the data descriptor flag clear, ZipCrypto's check byte is the high byte of the CRC. */
function checkByte(crc: number): number {
	return (crc >>> 24) & 0xff;
}

/** The three ZipCrypto key registers, set fresh for each entry (PKWARE APPNOTE section 6.1). */
type CipherKeys = { key0: number; key1: number; key2: number };

function createCipherKeys(password: Uint8Array): CipherKeys {
	const keys: CipherKeys = { key0: 0x12345678, key1: 0x23456789, key2: 0x34567890 };
	for (const byte of password) updateKeys(keys, byte);
	return keys;
}

function updateKeys(keys: CipherKeys, plainByte: number): void {
	keys.key0 = crc32Step(keys.key0, plainByte);
	keys.key1 = (Math.imul((keys.key1 + (keys.key0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
	keys.key2 = crc32Step(keys.key2, (keys.key1 >>> 24) & 0xff);
}

/** The next keystream byte. It depends only on key2, so it is known before the plaintext byte is. */
function keystreamByte(keys: CipherKeys): number {
	const temp = ((keys.key2 & 0xffff) | 2) >>> 0;
	return ((temp * (temp ^ 1)) >>> 8) & 0xff;
}

/**
 * XORs the keystream into `input` and writes the result to `output`, which must be the same length.
 * The key registers always advance on the plaintext byte: the input when encrypting, the output when decrypting.
 */
function zipCrypt(keys: CipherKeys, input: Uint8Array, output: Uint8Array, direction: "encrypt" | "decrypt"): void {
	for (let i = 0; i < input.length; i++) {
		output[i] = input[i] ^ keystreamByte(keys);
		updateKeys(keys, direction === "encrypt" ? input[i] : output[i]);
	}
}
