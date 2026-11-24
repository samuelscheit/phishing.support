import { expect, test } from "bun:test";

import { applyMigration, databaseBefore } from "../db/migration_test_helpers";

const MIGRATION = "0029_campaign_site_members";

test("0029 makes each case's member the member of its primary report, keeping every campaign; a case without one leaves", () => {
	const database = databaseBefore(MIGRATION);
	const website = (host: string) => `'{"kind":"website","website":{"url":"https://${host}/"}}'`;
	const report = (id: number, submissionId: number, createdAt: number, key: string | null) =>
		`INSERT INTO abuse_reports (id, submission_id, idempotency_key, tracking_token_hash, request_payload_hash, allegation_category, description, created_at) VALUES (${id}, ${submissionId}, ${key === null ? "NULL" : `'${key}'`}, 'token-${id}', 'hash-${id}', 'phishing', 'Report ${id}.', ${createdAt});`;
	database.exec(`
		INSERT INTO submissions (id, kind, data, dedupe_key, status) VALUES (1, 'website', ${website("a-test.com")}, 'a', 'reported'), (2, 'website', ${website("b-test.com")}, 'b', 'reported'), (3, 'website', ${website("c-test.com")}, 'c', 'reported');
		${report(100, 1, 50, "exfil:1:abc")}
		${report(101, 1, 60, null)}
		${report(102, 1, 70, null)}
		${report(200, 2, 50, null)}
		INSERT INTO campaigns (id, title) VALUES (5, 'Fake notice'), (6, 'Solo');
		INSERT INTO campaign_members (submission_id, campaign_id, joined_at) VALUES (1, 5, 1000), (2, 5, 1001), (3, 6, 1002);
		INSERT INTO campaign_site_facts (submission_id, language, thumbnail_artifact_id, blank_capture) VALUES (1, 'de', 9, 1), (3, 'en', 8, 0);
		INSERT INTO campaign_indicators (id, submission_id, kind, value, links, evidence, created_at) VALUES (7, 1, 'operator_server', 'telegram-bot:1', 1, '{"roles":["receives_data"]}', 20), (8, 2, 'operator_server', 'telegram-bot:1', 1, '{}', 21), (9, 3, 'origin_ip', '203.0.113.7', 0, '{}', 22);
	`);
	applyMigration(database, MIGRATION);

	// The oldest primary report, never a data drop's, names each case's site; case 3 had none.
	expect(database.query("SELECT submission_id, report_id, campaign_id, joined_at FROM campaign_members ORDER BY submission_id").all()).toEqual([
		{ submission_id: 1n, report_id: 101n, campaign_id: 5n, joined_at: 1000n },
		{ submission_id: 2n, report_id: 200n, campaign_id: 5n, joined_at: 1001n },
	]);
	expect(database.query("SELECT submission_id, report_id, language, thumbnail_artifact_id, blank_capture FROM campaign_site_facts").all()).toEqual([
		{ submission_id: 1n, report_id: 101n, language: "de", thumbnail_artifact_id: 9n, blank_capture: 1n },
	]);
	expect(database.query("SELECT id, submission_id, report_id, kind, value, links, evidence, created_at FROM campaign_indicators ORDER BY id").all()).toEqual([
		{ id: 7n, submission_id: 1n, report_id: 101n, kind: "operator_server", value: "telegram-bot:1", links: 1n, evidence: '{"roles":["receives_data"]}', created_at: 20n },
		{ id: 8n, submission_id: 2n, report_id: 200n, kind: "operator_server", value: "telegram-bot:1", links: 1n, evidence: "{}", created_at: 21n },
	]);
	expect(database.query("SELECT id, title FROM campaigns ORDER BY id").all()).toEqual([{ id: 5n, title: "Fake notice" }, { id: 6n, title: "Solo" }]);

	// A case is a member once per site report; one indicator value once per member.
	database.exec("INSERT INTO campaign_members (submission_id, report_id, campaign_id) VALUES (1, 102, 6)");
	expect(() => database.exec("INSERT INTO campaign_members (submission_id, report_id, campaign_id) VALUES (1, 102, 5)")).toThrow();
	database.exec(`INSERT INTO campaign_indicators (id, submission_id, report_id, kind, value, links, evidence) VALUES (10, 1, 102, 'operator_server', 'telegram-bot:1', 1, '{}')`);
	expect(() => database.exec(`INSERT INTO campaign_indicators (id, submission_id, report_id, kind, value, links, evidence) VALUES (11, 1, 102, 'operator_server', 'telegram-bot:1', 1, '{}')`)).toThrow();
	expect(database.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name LIKE 'campaign_%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => (row as { name: string }).name)).toEqual([
		"campaign_indicators_kind_value_idx",
		"campaign_indicators_member_kind_value_unique",
		"campaign_members_campaign_idx",
		"campaigns_merged_into_idx",
	]);
	expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
