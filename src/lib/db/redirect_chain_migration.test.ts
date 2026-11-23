import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Migration 0028 retires the per-site hand-off: a case now owns its whole
 * redirect chain. It runs on the rows the hand-off left behind.
 */
describe("the redirect-chain migration", () => {
	const hop = (index: number, url: string, extra: Record<string, unknown> = {}) => ({ index, url, hostname: new URL(url).hostname, status: 200, contentCaptured: false, ...extra });

	function migrate(rows: Array<{ id: number; kind?: string; status: string; info?: string | null; source?: string | null; data: unknown }>) {
		const db = new Database(":memory:");
		db.run("CREATE TABLE submissions (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, info TEXT, source TEXT, data TEXT NOT NULL)");
		db.run("CREATE TABLE abuse_reports (id INTEGER PRIMARY KEY)");
		const insert = db.query("INSERT INTO submissions VALUES (?, ?, ?, ?, ?, ?)");
		for (const row of rows) insert.run(row.id, row.kind ?? "website", row.status, row.info ?? null, row.source ?? null, typeof row.data === "string" ? row.data : JSON.stringify(row.data));
		const sql = readFileSync(path.join(import.meta.dir, "../../../drizzle/0028_redirect_chain_cases.sql"), "utf8");
		for (const statement of sql.split("--> statement-breakpoint")) db.run(statement);
		const read = (id: number) => {
			const row = db.query("SELECT status, info, source, data FROM submissions WHERE id = ?").get(id) as { status: string; info: string | null; source: string | null; data: string };
			return { ...row, data: (() => { try { return JSON.parse(row.data); } catch { return row.data; } })() };
		};
		return { db, read };
	}

	test("a case that handed its capture off keeps its info, names the destination's case, and has no verdict of its own", () => {
		const hops = [hop(0, "https://bit.ly/x", { status: 301, redirectTo: "https://kit.com/" }), hop(1, "https://kit.com/", { contentCaptured: true })];
		const { read } = migrate([
			{ id: 1, status: "redirected", info: "https://bit.ly/x redirects to kit.com; that site is analyzed and reported in its own case.", data: { kind: "website", website: { url: "https://bit.ly/x", navigationHops: hops, redirectSubmissionId: "2" } } },
			{ id: 2, status: "reported", source: "redirect:1", data: { kind: "website", website: { url: "https://kit.com/", navigationHops: [hop(0, "https://kit.com/", { contentCaptured: true })], laterPages: [{ url: "https://kit.com/step2", step: 2 }] } } },
			// A hand-off whose destination case was never named, and one without any info.
			{ id: 3, status: "redirected", info: null, data: { kind: "website", website: { url: "https://a.com/" } } },
		]);

		expect(read(1)).toEqual({
			status: "invalid",
			info: "https://bit.ly/x redirects to kit.com; that site is analyzed and reported in its own case. Its destination was analyzed in case 2.",
			source: null,
			data: { kind: "website", website: { url: "https://bit.ly/x", navigationHops: hops, analyzedHopIndex: 1 } },
		});
		expect(read(2).data.website).toEqual({ url: "https://kit.com/", navigationHops: [hop(0, "https://kit.com/", { contentCaptured: true })], analyzedHopIndex: 0 });
		expect(read(3)).toMatchObject({ status: "invalid", info: null });
	});

	test("a hand-off's destination takes the source its lineage started from, however deep", () => {
		const data = { kind: "website", website: { url: "https://x.com/" } };
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

	test("leaves other cases and data it cannot read alone, and creates the report-case links", () => {
		const { db, read } = migrate([
			{ id: 50, status: "reported", kind: "email", data: { kind: "email", email: { subject: "x" } } },
			{ id: 51, status: "invalid", data: "not json" },
			// A chain that never captured a page has no page to name.
			{ id: 52, status: "failed", data: { kind: "website", website: { url: "https://down.com/", navigationHops: [hop(0, "https://down.com/", { status: 302, redirectTo: "https://gone.com/" })] } } },
		]);
		expect(read(50)).toMatchObject({ status: "reported", data: { kind: "email", email: { subject: "x" } } });
		expect(read(51)).toMatchObject({ status: "invalid", data: "not json" });
		expect(read(52).data.website).not.toHaveProperty("analyzedHopIndex");
		db.run("INSERT INTO abuse_reports VALUES (1)");
		db.run("INSERT INTO abuse_report_cases (id, report_id, submission_id) VALUES (1, 1, 52)");
		expect(() => db.run("INSERT INTO abuse_report_cases (id, report_id, submission_id) VALUES (2, 1, 52)")).toThrow("UNIQUE");
		expect((db.query("SELECT created_at AS at FROM abuse_report_cases").get() as { at: number }).at).toBeGreaterThan(0);
	});
});
