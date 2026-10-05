import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { getDb } from "./index";
import { useTemporaryDatabase } from "./test_helpers";

useTemporaryDatabase();

test("SQLite uses WAL and a busy timeout for concurrent server and worker access", async () => {
	const db = await getDb();
	const client = (db as unknown as { $client: Database }).$client;

	expect(client.query("PRAGMA journal_mode").get() as { journal_mode: string }).toEqual({ journal_mode: "wal" });
	expect(client.query("PRAGMA busy_timeout").get() as { timeout: bigint }).toEqual({ timeout: 10_000n });
});
