import { describe, expect, test } from "bun:test";
import { resetDatabaseForTesting } from "../../../db";
import { useTemporaryDatabase } from "../../../db/test_helpers";
import { getCloudflareSession } from "./session";
import { sqliteCloudflareSessionStore as store } from "./session-store";

useTemporaryDatabase();

describe("persistent dashboard session cache", () => {
	test("migrates a fresh DB and persists session credentials across connections", async () => {
		expect(await store.read("account")).toEqual({});
		const session = { atok: "test-atok", vses2: "test-cookie", expiresAt: Date.now() + 3_600_000 };
		await store.writeSession("account", session);
		await resetDatabaseForTesting();
		expect((await store.read("account")).session).toEqual(session);
		await store.writeSession("account", { ...session, atok: "replacement" });
		expect((await store.read("account")).session?.atok).toBe("replacement");
		await store.clear("account");
		expect(await store.read("account")).toEqual({});
	});

	test("failure cache survives reconnect and successful login clears it", async () => {
		const failure = { message: "Cloudflare dashboard login failed.", until: Date.now() + 30_000 };
		await store.writeFailure("account", failure);
		await resetDatabaseForTesting();
		expect((await store.read("account")).failure).toEqual(failure);
		const session = { atok: "test-atok", vses2: "test-cookie", expiresAt: Date.now() + 3_600_000 };
		await store.writeSession("account", session);
		expect(await store.read("account")).toEqual({ session, failure: undefined });
	});

	test("real SQLite lease and cache coordinate login and explicit renewal", async () => {
		const config = { accountId: "a".repeat(32), email: "test@example.com", password: "not-persisted" };
		let calls = 0;
		const login = async () => ({ atok: `token-${++calls}`, vses2: "test-cookie", expiresAt: Date.now() + 3_600_000 });
		const sessions = await Promise.all(Array.from({ length: 10 }, () => getCloudflareSession(config, {}, { login })));
		expect(calls).toBe(1);
		expect(sessions.every((session) => session.atok === "token-1")).toBe(true);
		await resetDatabaseForTesting();
		expect((await getCloudflareSession(config, {}, { login })).atok).toBe("token-1");
		expect(calls).toBe(1);
		expect((await getCloudflareSession(config, { expiredSession: sessions[0] }, { login })).atok).toBe("token-2");
		expect(calls).toBe(2);
	});
});
