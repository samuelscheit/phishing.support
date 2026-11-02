import { describe, expect, test } from "bun:test";

import { signatureStateOf } from "./pe_signature";

describe("structural signature mapping used by the pipeline", () => {
	test("a file that is not a PE (a ZIP, a script, an HTML page) is not a signed installer", () => {
		expect(signatureStateOf(Buffer.from("PK\u0003\u0004zip-body"))).toBe("not_signed");
		expect(signatureStateOf(Buffer.from("<html>kit</html>"))).toBe("not_signed");
	});

	test("a truncated MZ executable fails closed: it is never upload-eligible as an ordinary file", () => {
		// Regression: an "MZ" file shorter than its DOS header used to be reported as not_pe,
		// which mapped to not_signed and so permitted an upload of a Windows executable.
		expect(signatureStateOf(Buffer.from([0x4d, 0x5a, 0, 0, 0, 0, 0, 0]))).toBe("unknown");
		expect(signatureStateOf(Buffer.from([0x4d]))).toBe("not_signed");
	});

	test("a malformed PE fails closed rather than being treated as unsigned", () => {
		const malformed = Buffer.alloc(0x100);
		malformed.writeUInt16LE(0x5a4d, 0);
		malformed.writeUInt32LE(0xffff_fff0, 0x3c);
		expect(signatureStateOf(malformed)).toBe("unknown");
	});

	test("a PE whose certificate table lies outside the file fails closed", () => {
		const bytes = Buffer.alloc(0x400);
		bytes.writeUInt16LE(0x5a4d, 0);
		bytes.writeUInt32LE(0x80, 0x3c);
		bytes.writeUInt32LE(0x00004550, 0x80);
		bytes.writeUInt16LE(0x10b, 0x80 + 24);
		bytes.writeUInt32LE(16, 0x80 + 24 + 92);
		bytes.writeUInt32LE(0x3f0, 0x80 + 24 + 96 + 32);
		bytes.writeUInt32LE(0x100, 0x80 + 24 + 96 + 36);
		expect(signatureStateOf(bytes)).toBe("unknown");
	});
});
