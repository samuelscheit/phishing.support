import { describe, expect, test } from "bun:test";

import { readPeCertificateTable } from "./pe_signature";

/** Build a minimal PE image with the given optional-header kind and certificate-table entry. */
function peImage(options: { plus?: boolean; directoryCount?: number; certificate?: { offset: number; size: number }; length?: number } = {}): Buffer {
	const plus = options.plus ?? false;
	const size = options.length ?? 0x400;
	const bytes = Buffer.alloc(size);
	bytes.writeUInt16LE(0x5a4d, 0); // MZ
	const peOffset = 0x80;
	bytes.writeUInt32LE(peOffset, 0x3c);
	bytes.writeUInt32LE(0x00004550, peOffset); // PE\0\0
	const optionalOffset = peOffset + 24;
	bytes.writeUInt16LE(plus ? 0x20b : 0x10b, optionalOffset);
	const countOffset = optionalOffset + (plus ? 108 : 92);
	const directoriesOffset = optionalOffset + (plus ? 112 : 96);
	bytes.writeUInt32LE(options.directoryCount ?? 16, countOffset);
	if (options.certificate) {
		const entry = directoriesOffset + 4 * 8;
		bytes.writeUInt32LE(options.certificate.offset, entry);
		bytes.writeUInt32LE(options.certificate.size, entry + 4);
	}
	return bytes;
}

describe("PE certificate table reader", () => {
	test("reads a PE32 certificate table as a file offset and size", () => {
		expect(readPeCertificateTable(peImage({ certificate: { offset: 0x200, size: 0x80 } })))
			.toEqual({ kind: "certificate_table", offset: 0x200, size: 0x80 });
	});

	test("reads a PE32+ certificate table at the wider header offsets", () => {
		expect(readPeCertificateTable(peImage({ plus: true, certificate: { offset: 0x180, size: 0x40 } })))
			.toEqual({ kind: "certificate_table", offset: 0x180, size: 0x40 });
	});

	test("an image with no certificate table is unsigned", () => {
		expect(readPeCertificateTable(peImage())).toEqual({ kind: "unsigned" });
		expect(readPeCertificateTable(peImage({ directoryCount: 4 }))).toEqual({ kind: "unsigned" });
	});

	test("a certificate table that points outside the file is malformed, never read", () => {
		const state = readPeCertificateTable(peImage({ certificate: { offset: 0x3f0, size: 0x100 } }));
		expect(state).toMatchObject({ kind: "malformed", reason: "certificate table outside the file" });
	});

	test("a certificate table smaller than its own header is malformed", () => {
		expect(readPeCertificateTable(peImage({ certificate: { offset: 0x200, size: 4 } }))).toMatchObject({ kind: "malformed" });
	});

	test("a truncated file is malformed rather than read past its end", () => {
		const truncated = peImage({ certificate: { offset: 0x200, size: 0x80 } }).subarray(0, 0x90);
		expect(readPeCertificateTable(truncated)).toMatchObject({ kind: "malformed" });
	});

	test("a PE offset past the file end is malformed", () => {
		const bytes = Buffer.alloc(0x100);
		bytes.writeUInt16LE(0x5a4d, 0);
		bytes.writeUInt32LE(0xffff_fff0, 0x3c);
		expect(readPeCertificateTable(bytes)).toMatchObject({ kind: "malformed" });
	});

	test("non-PE data is reported as not a PE file, not as unsigned", () => {
		expect(readPeCertificateTable(Buffer.from("PK\u0003\u0004 not a portable executable"))).toEqual({ kind: "not_pe" });
		expect(readPeCertificateTable(Buffer.alloc(8))).toEqual({ kind: "not_pe" });
	});

	test("an unknown optional-header magic is malformed", () => {
		const bytes = peImage();
		bytes.writeUInt16LE(0x1234, 0x80 + 24);
		expect(readPeCertificateTable(bytes)).toEqual({ kind: "malformed", reason: "unknown optional header magic" });
	});
});
