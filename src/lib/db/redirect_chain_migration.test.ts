import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { reportConfirmedWebsiteAbuse } from "../abuse/submission_reports";
import { getReportsForSubmission } from "../submissions/abuse_details";
import { SubmissionsEntity } from "./entities/submissions";
import { getDb } from "./index";
import { useTemporaryDatabase } from "./test_helpers";

useTemporaryDatabase();

const migrationSql = readFileSync(path.join(import.meta.dir, "../../../drizzle/0028_redirect_chain_cases.sql"), "utf8");

/** Run migration 0028 statement by statement, as drizzle's migrator does. */
function runMigration(db: Database) {
	for (const statement of migrationSql.split("--> statement-breakpoint")) db.run(statement);
}

/**
 * Migration 0028 retires the per-site hand-off: a case now owns its whole
 * redirect chain. It runs on the rows the hand-off left behind.
 */
describe("the redirect-chain migration", () => {
	const hop = (index: number, url: string, extra: Record<string, unknown> = {}) => ({ index, url, hostname: new URL(url).hostname, status: 200, contentCaptured: false, ...extra });
	const site = (url: string, extra: Record<string, unknown> = {}) => ({ kind: "website", website: { url, ...extra } });
	const handOff = (destination: number | string) => site("https://short.example/", { redirectSubmissionId: String(destination) });

	function migrate(
		rows: Array<{ id: number; kind?: string; status: string; info?: string | null; source?: string | null; data: unknown }>,
		reports: Array<{ id: number; submissionId: number; idempotencyKey?: string }> = [],
	) {
		const db = new Database(":memory:");
		db.run("CREATE TABLE submissions (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, info TEXT, source TEXT, data TEXT NOT NULL)");
		db.run("CREATE TABLE abuse_reports (id INTEGER PRIMARY KEY, submission_id INTEGER, idempotency_key TEXT)");
		const insert = db.query("INSERT INTO submissions VALUES (?, ?, ?, ?, ?, ?)");
		for (const row of rows) insert.run(row.id, row.kind ?? "website", row.status, row.info ?? null, row.source ?? null, typeof row.data === "string" ? row.data : JSON.stringify(row.data));
		const insertReport = db.query("INSERT INTO abuse_reports VALUES (?, ?, ?)");
		for (const report of reports) insertReport.run(report.id, report.submissionId, report.idempotencyKey ?? null);
		runMigration(db);
		const read = (id: number) => {
			const row = db.query("SELECT status, info, source, data FROM submissions WHERE id = ?").get(id) as { status: string; info: string | null; source: string | null; data: string };
			return { ...row, data: (() => { try { return JSON.parse(row.data); } catch { return row.data; } })() };
		};
		const joined = () => db.query("SELECT id, report_id AS reportId, submission_id AS submissionId FROM abuse_report_cases ORDER BY id").all();
		return { db, read, joined };
	}

	test("a case that handed its capture off keeps its info, takes its destination's verdict, and names the destination's case", () => {
		const hops = [hop(0, "https://bit.ly/x", { status: 301, redirectTo: "https://kit.com/" }), hop(1, "https://kit.com/", { contentCaptured: true })];
		const { read, joined } = migrate([
			{ id: 1, status: "redirected", info: "https://bit.ly/x redirects to kit.com; that site is analyzed and reported in its own case.", data: { kind: "website", website: { url: "https://bit.ly/x", navigationHops: hops, redirectSubmissionId: "2" } } },
			{ id: 2, status: "reported", source: "redirect:1", data: { kind: "website", website: { url: "https://kit.com/", navigationHops: [hop(0, "https://kit.com/", { contentCaptured: true })], laterPages: [{ url: "https://kit.com/step2", step: 2 }] } } },
			// A hand-off whose destination case was never named, and one without any info.
			{ id: 3, status: "redirected", info: null, data: { kind: "website", website: { url: "https://a.com/" } } },
		], [{ id: 900, submissionId: 2 }]);

		expect(read(1)).toEqual({
			status: "reported",
			info: "https://bit.ly/x redirects to kit.com; that site is analyzed and reported in its own case. Its destination was analyzed in case 2.",
			source: null,
			data: { kind: "website", website: { url: "https://bit.ly/x", navigationHops: hops, analyzedHopIndex: 1 } },
		});
		expect(read(2)).toMatchObject({ status: "reported", source: null });
		expect(read(2).data.website).toEqual({ url: "https://kit.com/", navigationHops: [hop(0, "https://kit.com/", { contentCaptured: true })], analyzedHopIndex: 0 });
		expect(read(3)).toMatchObject({ status: "invalid", info: null });
		expect(joined()).toEqual([{ id: 1, reportId: 900, submissionId: 1 }]);
	});

	test("a hand-off follows its chain of hand-offs to the case that reached a verdict", () => {
		const { read, joined } = migrate([
			// A → B → C, C reported: both hand-offs join C's own reports, not its follow-ups or another case's.
			{ id: 1, status: "redirected", info: "A.", data: handOff(2) },
			{ id: 2, status: "redirected", info: "B.", data: handOff(3) },
			{ id: 3, status: "reported", data: site("https://kit.com/") },
			// A → B failed, A → B invalid: the verdict is copied, no report joined.
			{ id: 10, status: "redirected", data: handOff(11) },
			{ id: 11, status: "failed", data: site("https://down.example/") },
			{ id: 20, status: "redirected", data: handOff(21) },
			{ id: 21, status: "invalid", data: site("https://benign.example/") },
			// A reported destination that filed no report of its own joins nothing but still reads as reported.
			{ id: 25, status: "redirected", data: handOff(26) },
			{ id: 26, status: "reported", data: site("https://unreported.example/") },
		], [
			{ id: 300, submissionId: 3 },
			{ id: 301, submissionId: 3 },
			{ id: 302, submissionId: 3, idempotencyKey: "exfiltration:3:drop.example" },
			{ id: 303, submissionId: 11 },
			{ id: 304, submissionId: 99 },
		]);

		expect(read(1)).toMatchObject({ status: "reported", info: "A. Its destination was analyzed in case 3." });
		expect(read(2)).toMatchObject({ status: "reported", info: "B. Its destination was analyzed in case 3." });
		expect(read(10)).toMatchObject({ status: "failed", info: "Its destination was analyzed in case 11." });
		expect(read(20)).toMatchObject({ status: "invalid", info: "Its destination was analyzed in case 21." });
		expect(read(25)).toMatchObject({ status: "reported", info: "Its destination was analyzed in case 26." });
		expect([3, 11, 21, 26].map((id) => read(id).status)).toEqual(["reported", "failed", "invalid", "reported"]);
		// Ids counted from 1, in case then report order; none can meet a snowflake id.
		expect(joined()).toEqual([
			{ id: 1, reportId: 300, submissionId: 1 },
			{ id: 2, reportId: 301, submissionId: 1 },
			{ id: 3, reportId: 300, submissionId: 2 },
			{ id: 4, reportId: 301, submissionId: 2 },
		]);
		for (const id of [1, 2, 10, 20, 25]) expect(read(id).data.website).not.toHaveProperty("redirectSubmissionId");
	});

	test("a hand-off whose chain ends in no verdict has none of its own and names no case", () => {
		const longChain = Array.from({ length: 25 }, (_, index) => ({ id: 100 + index, status: "redirected", data: handOff(101 + index) }));
		const { read, joined } = migrate([
			// The destination is gone.
			{ id: 1, status: "redirected", info: "A.", data: handOff(999) },
			// A → B → A and a case naming itself loop.
			{ id: 2, status: "redirected", data: handOff(3) },
			{ id: 3, status: "redirected", data: handOff(2) },
			{ id: 4, status: "redirected", data: handOff(4) },
			// The destination is still being analyzed, or itself names no destination.
			{ id: 5, status: "redirected", data: handOff(6) },
			{ id: 6, status: "running", data: site("https://slow.example/") },
			{ id: 7, status: "redirected", data: handOff(8) },
			{ id: 8, status: "redirected", data: site("https://b.example/") },
			// A link that is no case id, data that is no JSON, and JSON that is no object.
			{ id: 9, status: "redirected", data: handOff("not-a-case") },
			{ id: 10, status: "redirected", info: "Unreadable.", data: "{not json" },
			{ id: 11, status: "redirected", data: "[1, 2]" },
			// More than 20 hand-offs before the verdict.
			...longChain,
			{ id: 125, status: "reported", data: site("https://far.example/") },
		], [{ id: 500, submissionId: 125 }, { id: 501, submissionId: 6 }]);

		expect(read(1)).toMatchObject({ status: "invalid", info: "A." });
		for (const id of [2, 3, 4, 5, 7, 8, 9, 11]) expect(read(id)).toMatchObject({ status: "invalid", info: null });
		expect(read(10)).toEqual({ status: "invalid", info: "Unreadable.", source: null, data: "{not json" });
		expect(read(6).status).toBe("running");
		// The last 20 of the long chain still reach the verdict; the first ones are too far from it.
		expect(read(100)).toMatchObject({ status: "invalid", info: null });
		expect(read(105)).toMatchObject({ status: "reported", info: "Its destination was analyzed in case 125." });
		expect(read(124)).toMatchObject({ status: "reported", info: "Its destination was analyzed in case 125." });
		expect(joined().map((row) => (row as { submissionId: number }).submissionId)).toEqual(Array.from({ length: 20 }, (_, index) => 105 + index));
	});

	test("a hand-off's destination takes the source its lineage started from, however deep", () => {
		const data = site("https://x.com/");
		const { read } = migrate([
			{ id: 10, status: "reported", source: "kit-sibling:9:1", data },
			{ id: 11, status: "redirected", source: "redirect:10", data },
			{ id: 12, status: "reported", source: "redirect:11", data },
			{ id: 20, status: "redirected", source: null, data },
			{ id: 21, status: "reported", source: "redirect:20", data },
			// The case it came from is gone.
			{ id: 30, status: "reported", source: "redirect:999", data },
			{ id: 40, status: "reported", source: "https://mail.example/", data },
		]);
		expect([10, 11, 12, 21, 30, 40].map((id) => read(id).source)).toEqual(["kit-sibling:9:1", "kit-sibling:9:1", "kit-sibling:9:1", null, null, "https://mail.example/"]);
	});

	test("names the first captured hop, reading hops that are no object as nothing", () => {
		const { read } = migrate([
			{ id: 1, status: "reported", data: site("https://a.com/", { navigationHops: ["not a hop", 7, null, hop(3, "https://a.com/", { contentCaptured: true }), hop(4, "https://a.com/2", { contentCaptured: true })] }) },
			// Hops that are no array, a captured hop without an index, and no captured hop at all.
			{ id: 2, status: "reported", data: site("https://b.com/", { navigationHops: { contentCaptured: true, index: 0 } }) },
			{ id: 3, status: "reported", data: site("https://c.com/", { navigationHops: [{ url: "https://c.com/", contentCaptured: true }] }) },
			{ id: 4, status: "failed", data: site("https://down.com/", { navigationHops: [hop(0, "https://down.com/", { status: 302, redirectTo: "https://gone.com/" })] }) },
			{ id: 5, status: "reported", data: { kind: "website", website: "not an object" } },
		]);
		expect(read(1).data.website.analyzedHopIndex).toBe(3);
		for (const id of [2, 3, 4]) expect(read(id).data.website).not.toHaveProperty("analyzedHopIndex");
		expect(read(5).data).toEqual({ kind: "website", website: "not an object" });
	});

	test("leaves other cases and data it cannot read alone, and creates the report-case links", () => {
		const { db, read } = migrate([
			{ id: 50, status: "reported", kind: "email", data: { kind: "email", email: { subject: "x" } } },
			{ id: 51, status: "invalid", data: "not json" },
			{ id: 52, status: "failed", data: site("https://down.com/", { laterPages: [] }) },
		]);
		expect(read(50)).toMatchObject({ status: "reported", data: { kind: "email", email: { subject: "x" } } });
		expect(read(51)).toMatchObject({ status: "invalid", data: "not json" });
		expect(read(52).data.website).toEqual({ url: "https://down.com/" });
		// The outcome table was only the migration's own.
		expect(db.query("SELECT name FROM sqlite_temp_master WHERE name = 'hand_off_outcomes'").get()).toBeNull();
		db.run("INSERT INTO abuse_reports VALUES (1, 52, NULL)");
		db.run("INSERT INTO abuse_report_cases (id, report_id, submission_id) VALUES (1, 1, 52)");
		expect(() => db.run("INSERT INTO abuse_report_cases (id, report_id, submission_id) VALUES (2, 1, 52)")).toThrow("UNIQUE");
		expect((db.query("SELECT created_at AS at FROM abuse_report_cases").get() as { at: number }).at).toBeGreaterThan(0);
	});
});

describe("a migrated hand-off on the app's database", () => {
	const environmentNames = ["SMTP_FROM", "REPLY_DOMAIN", "ABUSE_TRACKING_TOKEN_SECRET"] as const;
	const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
	beforeEach(() => {
		process.env.SMTP_FROM = "support@phishing.support";
		process.env.REPLY_DOMAIN = "phishing.support";
		process.env.ABUSE_TRACKING_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-bytes-long";
	});
	afterAll(() => {
		for (const name of environmentNames) {
			const value = originalEnvironment[name];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	test("shows the report its final destination's case made", async () => {
		const create = (id: bigint, url: string) => SubmissionsEntity.create({ id, kind: "website", data: { kind: "website", website: { url } }, dedupeKey: `redirect-chain-migration:${id.toString()}`, status: "reported" });
		const [source, middle, destination] = [1001n, 1002n, 1003n];
		await create(source, "https://short.example.com/");
		await create(middle, "https://hop.example.com/");
		await create(destination, "https://kit.example.com/");
		const report = await reportConfirmedWebsiteAbuse({
			submissionId: destination,
			urls: ["https://kit.example.com/"],
			analysisText: "The captured page impersonates a trusted service and collects credentials.",
			reporter: {},
			finding: { finding: "phishing", phishingBasis: "credential_theft" },
		});

		// The rows as the hand-off left them, on a database just before 0028.
		const client = (await getDb()).$client;
		const handOff = client.query("UPDATE submissions SET status = 'redirected', data = json_set(data, '$.website.redirectSubmissionId', ?) WHERE id = ?");
		handOff.run(middle.toString(), source);
		handOff.run(destination.toString(), middle);
		client.run("DROP TABLE abuse_report_cases");
		runMigration(client);

		for (const id of [source, middle]) {
			const reports = await getReportsForSubmission(id);
			expect(reports.map((shown) => [shown.id, shown.submissionId, shown.joinedCases])).toEqual([[report.reportId, destination, [source, middle]]]);
			expect((await SubmissionsEntity.get(id))?.status).toBe("reported");
		}
		expect((await getReportsForSubmission(destination)).map((shown) => shown.id)).toEqual([report.reportId]);
	});
});
