import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readProtectedArchive, writeProtectedArchive } from "./protected_archive";

const BSDTAR = "/usr/bin/bsdtar";
const PASSWORD = "infected";
let scratch: string;

beforeAll(() => { scratch = mkdtempSync(path.join(tmpdir(), "protected-archive-test-")); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

describe("protected archive round trip (AES-256)", () => {
	test("returns the same entry name and bytes for a random buffer", async () => {
		const data = randomBytes(4096);
		const archive = await writeProtectedArchive({ entryName: "sample.bin", data, password: PASSWORD });
		const back = await readProtectedArchive(archive, PASSWORD);
		expect(back.entryName).toBe("sample.bin");
		expect(back.data.equals(data)).toBeTrue();
	});

	test("round-trips empty data", async () => {
		const archive = await writeProtectedArchive({ entryName: "sample.bin", data: Buffer.alloc(0), password: PASSWORD });
		expect((await readProtectedArchive(archive, PASSWORD)).data.byteLength).toBe(0);
	});

	test("never stores the sample bytes in the clear", async () => {
		const marker = Buffer.from("PLAINTEXT-MARKER-THAT-MUST-NOT-APPEAR");
		const archive = await writeProtectedArchive({ entryName: "sample.bin", data: marker, password: PASSWORD });
		expect(archive.includes(marker)).toBeFalse();
	});

	test("writes AES, not the broken ZipCrypto cipher", async () => {
		const archive = await writeProtectedArchive({ entryName: "sample.bin", data: Buffer.from("x".repeat(64)), password: PASSWORD });
		// The archive must be readable by the reader only with AES; a ZipCrypto archive would be
		// rejected by the zipCrypto guard in readProtectedArchive, so a round trip proves the cipher.
		expect((await readProtectedArchive(archive, PASSWORD)).data.toString()).toBe("x".repeat(64));
	});

	test("produces a different archive for the same input each time", async () => {
		const data = Buffer.from("same-sample");
		const first = await writeProtectedArchive({ entryName: "sample.bin", data, password: PASSWORD });
		const second = await writeProtectedArchive({ entryName: "sample.bin", data, password: PASSWORD });
		expect(first.equals(second)).toBeFalse();
	});
});

describe("protected archive failures", () => {
	// zip.js reports the same "Invalid password" error for a wrong password and a damaged
	// payload, so these tests use a promise handler rather than `expect().rejects`: the
	// latter never settles on this rejection path under Bun's test runner.
	const outcomeOf = (promise: Promise<unknown>) => promise.then(() => "resolved", (error: Error) => error.message);

	test("a wrong password is refused, and no bytes are returned", async () => {
		const archive = await writeProtectedArchive({ entryName: "sample.bin", data: Buffer.from("secret-body"), password: PASSWORD });
		expect(await outcomeOf(readProtectedArchive(archive, "nope")))
			.toBe("Protected archive could not be opened: the password is wrong or the archive is damaged.");
	});

	test("a damaged archive is refused, and no bytes are returned", async () => {
		const archive = await writeProtectedArchive({ entryName: "sample.bin", data: Buffer.from("payload-bytes-here"), password: PASSWORD });
		const tampered = Buffer.from(archive);
		// Flip a byte inside the encrypted payload, past the local header.
		tampered[60] = tampered[60]! ^ 0xff;
		expect(await outcomeOf(readProtectedArchive(tampered, PASSWORD)))
			.toBe("Protected archive could not be opened: the password is wrong or the archive is damaged.");
	});

	test("a directory entry or a foreign entry name is not accepted as a sample", async () => {
		await expect(writeProtectedArchive({ entryName: "../escape.bin", data: Buffer.from("x"), password: PASSWORD })).rejects.toThrow("fixed sample name");
		await expect(writeProtectedArchive({ entryName: "other.bin", data: Buffer.from("x"), password: PASSWORD })).rejects.toThrow("fixed sample name");
	});

	test("an empty or oversized password is refused before any encryption", async () => {
		await expect(writeProtectedArchive({ entryName: "sample.bin", data: Buffer.from("x"), password: "" })).rejects.toThrow("non-empty password");
		await expect(writeProtectedArchive({ entryName: "sample.bin", data: Buffer.from("x"), password: "p".repeat(256) })).rejects.toThrow("too long");
	});

	test("a sample above the size limit is refused rather than written", async () => {
		const oversize = Buffer.alloc(100 * 1024 * 1024 + 1);
		await expect(writeProtectedArchive({ entryName: "sample.bin", data: oversize, password: PASSWORD })).rejects.toThrow("size limit");
	});
});

describe("interoperability with bsdtar (libarchive), which opens AES ZIP", () => {
	test.skipIf(!existsSync(BSDTAR))("bsdtar extracts the exact bytes with the password and refuses a wrong one", async () => {
		const data = randomBytes(2048);
		const archivePath = path.join(scratch, "interop.zip");
		writeFileSync(archivePath, await writeProtectedArchive({ entryName: "sample.bin", data, password: PASSWORD }));
		const outDir = path.join(scratch, "extract-ok");
		Bun.spawnSync(["mkdir", "-p", outDir]);
		const good = Bun.spawnSync([BSDTAR, "-xf", archivePath, "-C", outDir, "--passphrase", PASSWORD]);
		expect(good.exitCode).toBe(0);
		expect(Buffer.from(await Bun.file(path.join(outDir, "sample.bin")).arrayBuffer()).equals(data)).toBeTrue();

		const badDir = path.join(scratch, "extract-bad");
		Bun.spawnSync(["mkdir", "-p", badDir]);
		const bad = Bun.spawnSync([BSDTAR, "-xf", archivePath, "-C", badDir, "--passphrase", "wrong"]);
		// bsdtar reports the wrong passphrase with a non-zero exit, but it still writes a zero-byte
		// placeholder named sample.bin. An analyst must therefore check the SHA-256 recorded in the
		// database before trusting any extracted file; the exit status alone is not enough.
		expect(bad.exitCode).not.toBe(0);
	});
});
