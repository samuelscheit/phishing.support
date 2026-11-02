import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readProtectedArchive, writeProtectedArchive } from "./protected_archive";

const UNZIP = "/usr/bin/unzip";
const PASSWORD = "infected";
let scratch: string;

beforeAll(() => { scratch = mkdtempSync(path.join(tmpdir(), "protected-archive-test-")); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

describe("protected archive round trip", () => {
	test("returns the same entry name and bytes for a random buffer", () => {
		const data = randomBytes(4096);
		const archive = writeProtectedArchive({ entryName: "sample.bin", data, password: PASSWORD });
		const back = readProtectedArchive(archive, PASSWORD);
		expect(back.entryName).toBe("sample.bin");
		expect(back.data.equals(data)).toBeTrue();
	});

	test("round-trips empty data", () => {
		const archive = writeProtectedArchive({ entryName: "empty.bin", data: Buffer.alloc(0), password: PASSWORD });
		expect(readProtectedArchive(archive, PASSWORD).data.byteLength).toBe(0);
	});

	test("starts with the local-file signature and ends with the end-of-central-directory signature", () => {
		const archive = writeProtectedArchive({ entryName: "sample.bin", data: Buffer.from("x"), password: PASSWORD });
		expect(archive.subarray(0, 4).toString("hex")).toBe("504b0304");
		expect(archive.includes(Buffer.from("504b0506", "hex"))).toBeTrue();
	});
});

describe("protected archive password and integrity", () => {
	test("a wrong password is rejected with the generic message and no password echo", () => {
		const archive = writeProtectedArchive({ entryName: "sample.bin", data: Buffer.from("secret-body"), password: PASSWORD });
		expect(() => readProtectedArchive(archive, "nope")).toThrow("Protected archive could not be opened with the supplied password.");
		try {
			readProtectedArchive(archive, "nope");
		} catch (error) {
			expect((error as Error).message.includes("nope")).toBeFalse();
		}
	});

	test("an empty or over-long password is refused when writing", () => {
		expect(() => writeProtectedArchive({ entryName: "a.bin", data: Buffer.from("x"), password: "" })).toThrow();
		expect(() => writeProtectedArchive({ entryName: "a.bin", data: Buffer.from("x"), password: "p".repeat(256) })).toThrow();
	});

	test("tampering with a ciphertext byte makes the archive unreadable", () => {
		const data = Buffer.from("payload-that-must-not-be-altered-silently");
		const archive = writeProtectedArchive({ entryName: "sample.bin", data, password: PASSWORD });
		// The encrypted payload begins after the 30-byte local header and the entry name.
		const payloadOffset = 30 + "sample.bin".length;
		const tampered = Buffer.from(archive);
		tampered[payloadOffset + 14] ^= 0x01;
		expect(() => readProtectedArchive(tampered, PASSWORD)).toThrow();
	});
});

describe("protected archive entry names and size gate", () => {
	test("refuses names that could escape a directory, hide a file, or break the format", () => {
		for (const entryName of ["", "../x", "a/b", ".hidden", "x".repeat(101), "name with space", "héllo"]) {
			expect(() => writeProtectedArchive({ entryName, data: Buffer.from("x"), password: PASSWORD })).toThrow();
		}
	});

	test("refuses data over the 100 MiB ceiling", () => {
		const oversize = Buffer.alloc(100 * 1024 * 1024 + 1);
		expect(() => writeProtectedArchive({ entryName: "big.bin", data: oversize, password: PASSWORD })).toThrow();
	});
});

describe("interoperability with the system unzip", () => {
	test.skipIf(!existsSync(UNZIP))("the system unzip tests and extracts the archive, and rejects a wrong password", () => {
		const data = randomBytes(2048);
		const archivePath = path.join(scratch, "interop.zip");
		writeFileSync(archivePath, writeProtectedArchive({ entryName: "sample.bin", data, password: PASSWORD }));
		expect(Bun.spawnSync([UNZIP, "-t", "-P", PASSWORD, archivePath]).exitCode).toBe(0);
		const extracted = Bun.spawnSync([UNZIP, "-p", "-P", PASSWORD, archivePath]);
		expect(Buffer.from(extracted.stdout).equals(data)).toBeTrue();
		expect(Bun.spawnSync([UNZIP, "-t", "-P", "wrongpass", archivePath]).exitCode).not.toBe(0);
	});
});
