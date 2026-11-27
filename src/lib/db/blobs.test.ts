import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { validateAbuseReportRequest } from "../abuse/contracts";
import { AbuseRepository } from "../abuse/repository";
import { sha256Hex } from "../util/hash";
import { blobDirectory, blobFilePath, readBlob, writeBlob } from "./blobs";
import { ArtifactsEntity } from "./entities/artifacts";
import { getDb, resetDatabaseForTesting } from "./index";
import { databaseBefore } from "./migration_test_helpers";
import { tamperBlob, useTemporaryDatabase } from "./test_helpers";

const { fileName } = useTemporaryDatabase();

/** Every file under the blob directory, relative to it. */
function storedFiles(): string[] {
	const directory = blobDirectory(fileName)!;
	if (!existsSync(directory)) return [];
	return (readdirSync(directory, { recursive: true, withFileTypes: true }) as Array<{ isFile(): boolean; name: string; parentPath: string }>)
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1))
		.sort();
}

describe("the blob store", () => {
	test("stores bytes once under their SHA-256, beside the database, and reads them back", () => {
		const bytes = Buffer.from("captured page");
		const sha256 = sha256Hex(bytes);
		expect(writeBlob(bytes)).toEqual({ sha256, size: bytes.byteLength });
		expect(writeBlob(Buffer.from("captured page"))).toEqual({ sha256, size: bytes.byteLength });
		expect(blobFilePath(sha256)).toBe(join(dirname(fileName), "blobs", sha256.slice(0, 2), sha256.slice(2, 4), sha256));
		// One file, no temp file left behind.
		expect(storedFiles()).toEqual([join(sha256.slice(0, 2), sha256.slice(2, 4), sha256)]);
		expect(readBlob(sha256).equals(bytes)).toBeTrue();
	});

	test("stores an empty file too", () => {
		const empty = writeBlob(Buffer.alloc(0));
		expect(empty).toEqual({ sha256: sha256Hex(Buffer.alloc(0)), size: 0 });
		expect(readBlob(empty.sha256)).toHaveLength(0);
		// Writing it again finds it stored.
		expect(writeBlob(Buffer.alloc(0))).toEqual(empty);
	});

	test("rewrites a stored blob whose size is wrong, and touches an intact one", () => {
		const bytes = Buffer.from("x".repeat(100));
		const { sha256 } = writeBlob(bytes);
		writeFileSync(blobFilePath(sha256), "truncated");
		writeBlob(bytes);
		expect(readFileSync(blobFilePath(sha256)).equals(bytes)).toBeTrue();
		const old = new Date(Date.now() - 86_400_000);
		utimesSync(blobFilePath(sha256), old, old);
		writeBlob(bytes);
		expect(statSync(blobFilePath(sha256)).mtimeMs).toBeGreaterThan(old.getTime() + 3_600_000);
	});

	test("returns the stored bytes as they are, so a reader comparing hashes sees tampering, and refuses a missing blob or a malformed hash", async () => {
		const bytes = Buffer.from("\x89PNG original");
		const id = await ArtifactsEntity.saveBuffer({ kind: "website_png", mimeType: "image/png", buffer: bytes });
		const stored = (await ArtifactsEntity.get(id))!;
		expect(stored.blob.equals(bytes)).toBeTrue();
		expect(sha256Hex(stored.blob)).toBe(stored.sha256);

		tamperBlob(stored.sha256, Buffer.from("\x89PNG altered!"));
		const tampered = (await ArtifactsEntity.get(id))!;
		expect(sha256Hex(tampered.blob)).not.toBe(tampered.sha256);

		rmSync(blobFilePath(stored.sha256));
		await expect(ArtifactsEntity.get(id)).rejects.toThrow(`Blob ${stored.sha256} is missing`);
		expect(() => readBlob("../../etc/passwd")).toThrow("is not a lowercase hex SHA-256");
		expect(() => readBlob("A".repeat(64))).toThrow("is not a lowercase hex SHA-256");
	});

	test("an abuse artifact is stored before its row, and read back with its bytes", async () => {
		const request = await validateAbuseReportRequest({ targets: ["kit-test.com"], allegationCategory: "phishing", description: "Credential phishing." });
		const { reportId } = await AbuseRepository.createReport({ request, reporter: {} });
		const bytes = Buffer.from("evidence bytes");
		const id = await AbuseRepository.saveArtifact({ reportId, name: "e.txt", kind: "user_evidence_original", mimeType: "text/plain", buffer: bytes });
		expect(readFileSync(blobFilePath(sha256Hex(bytes))).equals(bytes)).toBeTrue();
		expect((await AbuseRepository.getArtifact(reportId, id))?.blob.equals(bytes)).toBeTrue();
		expect((await AbuseRepository.listArtifacts(reportId)).find((artifact) => artifact.id === id)?.blob.equals(bytes)).toBeTrue();
		// The listing for read models never touches the bytes: it works with the blob gone.
		rmSync(blobFilePath(sha256Hex(bytes)));
		expect((await AbuseRepository.listArtifactMetadata(reportId)).find((artifact) => artifact.id === id)).toMatchObject({ size: bytes.byteLength, sha256: sha256Hex(bytes) });
		await expect(AbuseRepository.getArtifact(reportId, id)).rejects.toThrow("is missing");
	});

	test("an in-memory database keeps its blobs in memory, private to it, and gone with it", async () => {
		for (const memory of [":memory:", "file:blobs-test?mode=memory"]) {
			await resetDatabaseForTesting();
			process.env.DB_FILE_NAME = memory;
			const id = await ArtifactsEntity.saveBuffer({ kind: "upload", buffer: Buffer.from(`in ${memory}`) });
			const stored = (await ArtifactsEntity.get(id))!;
			expect(stored.blob.toString()).toBe(`in ${memory}`);
			expect(blobDirectory()).toBeUndefined();
			expect(() => blobFilePath(stored.sha256)).toThrow("keeps its blobs in memory");
			expect(storedFiles()).toEqual([]);
			await resetDatabaseForTesting();
			expect(() => readBlob(stored.sha256)).toThrow("missing from the in-memory blob store");
		}
	});
});

describe("a database from before 0038", () => {
	const MIGRATION = "0038_external_blobs_and_list_indexes";
	const journal = JSON.parse(readFileSync(join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf-8")) as { entries: Array<{ tag: string; when: number }> };

	test("has its inline blobs moved to the store by getDb(), byte for byte, before the migration drops the columns", async () => {
		const screenshot = Buffer.from(Array.from({ length: 300_000 }, (_, index) => index % 251));
		const page = Buffer.from("<html>kit</html>");
		const mail = Buffer.from("From: abuse@example\r\n\r\nTicket #1");
		const old = databaseBefore(MIGRATION);
		// As Drizzle's migrator records the migrations a database has.
		old.exec("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)");
		old.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('0037', ?)").run(journal.entries.find((entry) => entry.tag === "0037_submission_site_groups")!.when);
		old.exec(`
			INSERT INTO submissions (id, kind, data, dedupe_key, status) VALUES (1, 'website', '{"kind":"website","website":{"url":"https://kit-test.com/","routes":[{"hops":[],"siteAssessments":[{"hopIndex":0,"finding":"phishing"}]}]}}', 'one', 'reported');
			INSERT INTO abuse_reports (id, submission_id, tracking_token_hash, request_payload_hash, allegation_category, description) VALUES (1, 1, 't', 'p', 'phishing', 'd');
		`);
		const artifact = old.prepare("INSERT INTO artifacts (id, submission_id, kind, sha256, size, blob) VALUES (?, 1, 'capture', ?, ?, ?)");
		artifact.run(1, sha256Hex(screenshot), screenshot.byteLength, screenshot);
		// A row from before hashes were kept, and a second copy of the same bytes.
		artifact.run(2, null, null, page);
		artifact.run(3, sha256Hex(page), page.byteLength, page);
		artifact.run(4, null, null, Buffer.alloc(0));
		// A row naming a hash its bytes do not have keeps its bytes, under their own hash.
		const altered = Buffer.from("bytes changed in place");
		artifact.run(5, "c".repeat(64), 3, altered);
		old.prepare("INSERT INTO abuse_artifacts (id, report_id, name, kind, mime_type, sha256, size, blob) VALUES (1, 1, 'raw.eml', 'raw_mail', 'message/rfc822', ?, ?, ?)").run(sha256Hex(mail), mail.byteLength, mail);
		writeFileSync(fileName, old.serialize());
		old.close();

		const db = await getDb();
		const client = db.$client;
		for (const table of ["artifacts", "abuse_artifacts"]) {
			expect((client.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)).not.toContain("blob");
		}
		expect(client.query("SELECT id, sha256, size FROM artifacts ORDER BY id").all()).toEqual([
			{ id: 1n, sha256: sha256Hex(screenshot), size: BigInt(screenshot.byteLength) },
			{ id: 2n, sha256: sha256Hex(page), size: BigInt(page.byteLength) },
			{ id: 3n, sha256: sha256Hex(page), size: BigInt(page.byteLength) },
			{ id: 4n, sha256: sha256Hex(Buffer.alloc(0)), size: 0n },
			{ id: 5n, sha256: sha256Hex(altered), size: BigInt(altered.byteLength) },
		]);
		expect(storedFiles()).toHaveLength(5);
		for (const [id, bytes] of [[1n, screenshot], [2n, page], [3n, page], [4n, Buffer.alloc(0)], [5n, altered]] as const) {
			expect((await ArtifactsEntity.get(id))!.blob.equals(bytes)).toBeTrue();
		}
		expect((await AbuseRepository.getArtifact(1n, 1n))!.blob.equals(mail)).toBeTrue();
		// The case was named and labelled by the migration.
		expect(client.query("SELECT title, reported_as FROM submissions").get()).toEqual({ title: "https://kit-test.com/", reported_as: "phishing" });
		expect(client.query("PRAGMA foreign_key_check").all()).toEqual([]);

		// The next start finds nothing left to move.
		await resetDatabaseForTesting();
		await getDb();
		expect(storedFiles()).toHaveLength(5);
	});
});
