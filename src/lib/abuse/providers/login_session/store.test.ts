import { describe, expect, test } from "bun:test";

import { resetDatabaseForTesting } from "../../../db";
import { useTemporaryDatabase } from "../../../db/test_helpers";
import { createLoginSessions, type LoginSession } from "./session";
import { sqliteLoginSessionStore as store } from "./store";

useTemporaryDatabase();

type Fake = LoginSession & { secret: string };

describe("sqlite login session store", () => {
	test("migrates a fresh DB and persists session JSON across connections", async () => {
		expect(await store.read("account")).toEqual({});
		const session = { id: "a", secret: "test-secret", nested: { jar: ["x"] }, expiresAt: Date.now() + 3_600_000 };
		await store.writeSession("account", session, session.expiresAt);
		await resetDatabaseForTesting();
		expect((await store.read("account")).session).toEqual(session);
		await store.writeSession("account", { ...session, id: "b" }, session.expiresAt);
		expect(((await store.read("account")).session as Fake).id).toBe("b");
		await store.clear("account");
		expect(await store.read("account")).toEqual({});
	});

	test("failure cache survives reconnect and a successful login clears it", async () => {
		const failure = { message: "Fake login failed.", until: Date.now() + 30_000 };
		await store.writeFailure("account", failure);
		await resetDatabaseForTesting();
		expect(await store.read("account")).toEqual({ failure });
		const session = { id: "a", expiresAt: Date.now() + 3_600_000 };
		await store.writeSession("account", session, session.expiresAt);
		expect(await store.read("account")).toEqual({ session });
	});

	test("a failure written after a session keeps the session", async () => {
		const session = { id: "a", expiresAt: Date.now() + 3_600_000 };
		await store.writeSession("account", session, session.expiresAt);
		const failure = { message: "x", until: Date.now() + 1_000 };
		await store.writeFailure("account", failure);
		expect(await store.read("account")).toEqual({ session, failure });
	});

	test("real SQLite lease and cache coordinate login and explicit renewal", async () => {
		let calls = 0;
		const sessions = createLoginSessions<{ account: string }, Fake>({
			provider: "Fake",
			namespace: "fake",
			account: (c) => c.account,
			login: async () => ({ id: `token-${++calls}`, secret: "s", expiresAt: Date.now() + 3_600_000 }),
			parse: (value) => (value as Fake | null)?.id ? (value as Fake) : undefined,
			loginTimeoutMs: 10_000,
			failureTtlMs: 60_000,
			safetyMs: 1_000,
		});
		const config = { account: "a" };
		const results = await Promise.all(Array.from({ length: 10 }, () => sessions.get(config)));
		expect(calls).toBe(1);
		expect(results.every((s) => s.id === "token-1")).toBe(true);
		await resetDatabaseForTesting();
		expect((await sessions.get(config)).id).toBe("token-1");
		expect(calls).toBe(1);
		expect((await sessions.get(config, { expiredSession: results[0] })).id).toBe("token-2");
		expect(calls).toBe(2);
	});
});
