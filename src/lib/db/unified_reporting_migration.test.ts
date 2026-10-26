import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const migrationFolder = join(process.cwd(), "drizzle");
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function applyMigration(database: Database, name: string) {
	for (const statement of readFileSync(join(migrationFolder, name), "utf-8").split("--> statement-breakpoint")) {
		if (statement.trim()) database.exec(statement);
	}
}

const migrations = readdirSync(migrationFolder).filter((name) => name.endsWith(".sql")).sort();
const unified = "0010_unified_reporting.sql";

function databaseBeforeUnifiedReporting() {
	const directory = mkdtempSync(join(tmpdir(), "phishing-reporter-unified-migration-"));
	temporaryDirectories.push(directory);
	const database = new Database(join(directory, "migration.sqlite"), { safeIntegers: true });
	for (const migration of migrations.slice(0, migrations.indexOf(unified))) applyMigration(database, migration);
	return database;
}

const insert = (database: Database, table: string, row: Record<string, unknown>) => {
	const columns = Object.keys(row);
	database.query(`INSERT INTO \`${table}\` (${columns.map((column) => `\`${column}\``).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
		.run(...(Object.values(row) as never[]));
};

test("migrates every legacy report record into the reporting aggregate and drops the legacy tables", () => {
	const database = databaseBeforeUnifiedReporting();
	const submission = (id: bigint, kind: "email" | "website", data: unknown) =>
		insert(database, "submissions", { id, kind, data: JSON.stringify(data), dedupe_key: `s${id}`, status: "reported", reporter_ip: "8.8.8.8", created_at: 10n, updated_at: 10n });
	const artifact = (id: bigint, submissionId: bigint, kind: string, name: string, blob: string) =>
		insert(database, "artifacts", { id, submission_id: submissionId, name, kind, mime_type: "message/rfc822", sha256: "h" + id, size: blob.length, blob: Buffer.from(blob), created_at: 11n });

	// A website with a legacy SMTP thread (sent + one reply) and a legacy Google record.
	submission(1000n, "website", { kind: "website", website: { url: " https://Login.Example.com:8443/collect?x=1#frag" } });
	insert(database, "report_threads", { id: 2000n, submission_id: 1000n, to: JSON.stringify(["abuse@host.example"]), subject: "Report", reply_address: "case-a@phishing.support", reply_token: "a".repeat(32), status: "replied", created_at: 20n, updated_at: 21n });
	artifact(3000n, 1000n, "report_eml", "report.eml", "outbound mime");
	artifact(3001n, 1000n, "report_reply_eml", "reply.eml", "reply mime");
	artifact(3002n, 1000n, "screenshot", "website.png", "png");
	insert(database, "report_messages", { id: 4000n, thread_id: 2000n, direction: "outbound", kind: "report", status: "sent", from: "support@phishing.support", to: JSON.stringify(["abuse@host.example"]), subject: "Report", text_body: "Please investigate.", message_id: "<report-1@phishing.support>", raw_artifact_id: 3000n, occurred_at: 20n, created_at: 20n, updated_at: 20n });
	insert(database, "report_messages", { id: 4001n, thread_id: 2000n, direction: "inbound", kind: "reply", status: "received", from: "Host Abuse <abuse@host.example>", to: JSON.stringify(["case-a@phishing.support"]), subject: "Re: Report", text_body: "Suspended.", message_id: "<reply-1@host.example>", in_reply_to: "<report-1@phishing.support>", raw_artifact_id: 3001n, occurred_at: 21n, created_at: 21n, updated_at: 21n });
	insert(database, "provider_reports", { id: 5000n, submission_id: 1000n, channel: "email", to: "Google Safe Browsing", body: "The URL is a phishing site.", status: "sent", legacy: 1, created_at: 12n, updated_at: 12n });

	// An email with a sent Netcraft mail record (with its EML attachment) and a rejected one.
	submission(1001n, "email", { kind: "email", email: { headers: { routing: { originatingIp: "149.72.231.44" } } } });
	artifact(3100n, 1001n, "eml", "mail.eml", "phishing mime");
	insert(database, "provider_reports", { id: 5100n, submission_id: 1001n, channel: "netcraft_mail_v3", operation_key: "netcraft:mail:1001", to: "Netcraft Reporting API v3", body: "Original email submitted.", status: "sent", provider_message_id: "dddddddddddddddddddddddddddddddd", provider_submission_url: "https://report.netcraft.com/api/v3/submission/dddddddddddddddddddddddddddddddd", attachments_artifact_ids: JSON.stringify(["3100"]), legacy: 0, created_at: 13n, updated_at: 13n });
	insert(database, "provider_reports", { id: 5101n, submission_id: 1001n, channel: "email", to: "abuse@sender.example", subject: "Abuse", body: "Sent by sender.example.", status: "failed", error: "SMTP 550", legacy: 1, created_at: 14n, updated_at: 14n });

	// A website already reported by the worker, whose legacy thread duplicates the worker's sent mail.
	submission(1002n, "website", { kind: "website", website: { url: "https://shop.example.net/" } });
	insert(database, "abuse_reports", { id: 6000n, tracking_token_hash: "t".repeat(64), idempotency_key: "legacy-website:1002", request_payload_hash: "p", allegation_category: "phishing", description: "Analysis.", status: "failed", created_at: 30n, updated_at: 30n });
	insert(database, "abuse_targets", { id: 6001n, report_id: 6000n, ordinal: 0, original_input: "shop.example.net", original_inputs: "[]", normalized_target: "shop.example.net", target_type: "domain", created_at: 30n, updated_at: 30n });
	insert(database, "abuse_provider_routes", { id: 6002n, report_id: 6000n, target_id: 6001n, route_key: "email:abuse@hostinger.example", provider_registry_key: "email:hostinger.example", provider_display_name: "Hostinger", route_type: "email", verified_email: "abuse@hostinger.example", resolver_provenance: "{}", resolution_snapshot: "{}", status: "awaiting_provider_reply", created_at: 30n, updated_at: 30n });
	insert(database, "abuse_provider_routes", { id: 6003n, report_id: 6000n, target_id: 6001n, route_key: "provider_submission:cloudflare", provider_registry_key: "cloudflare", provider_display_name: "Cloudflare", route_type: "provider_submission", resolver_provenance: "{}", resolution_snapshot: "{}", status: "unknown_external_state", created_at: 30n, updated_at: 30n });
	insert(database, "abuse_mail_messages", { id: 6004n, report_id: 6000n, route_id: 6002n, direction: "outbound", kind: "report", status: "sent", message_id: "<abuse-1@phishing.support>", reply_address: "abuse-x@phishing.support", occurred_at: 30n, created_at: 30n, updated_at: 30n });
	insert(database, "report_threads", { id: 2100n, submission_id: 1002n, to: JSON.stringify(["abuse@hostinger.example"]), reply_address: "abuse-x@phishing.support", reply_token: "b".repeat(32), status: "replied", created_at: 31n, updated_at: 31n });
	artifact(3200n, 1002n, "report_reply_eml", "reply.eml", "hostinger reply");
	insert(database, "report_messages", { id: 4100n, thread_id: 2100n, direction: "outbound", kind: "report", status: "sent", to: "[]", message_id: "<abuse-1@phishing.support>", occurred_at: 30n, created_at: 30n, updated_at: 30n });
	insert(database, "report_messages", { id: 4101n, thread_id: 2100n, direction: "inbound", kind: "reply", status: "received", from: "abuse@hostinger.example", to: JSON.stringify(["abuse-x@phishing.support"]), text_body: "Already suspended.", message_id: "<hostinger-reply@hostinger.example>", raw_artifact_id: 3200n, occurred_at: 32n, created_at: 32n, updated_at: 32n });

	// A public API report keeps its idempotency key and has no submission.
	insert(database, "abuse_reports", { id: 7000n, tracking_token_hash: "u".repeat(64), idempotency_key: "hermes-123", request_payload_hash: "p", allegation_category: "phishing", description: "Public.", reporter_contact_email: "r@example.org", status: "waiting_provider", created_at: 40n, updated_at: 40n });
	insert(database, "mail_ingest", { id: 8000n, mailbox: "INBOX", uid_validity: 1, uid: 1, route: "reply", report_message_id: 4001n, terminal: 1, processed_at: 21n, created_at: 21n, updated_at: 21n });

	applyMigration(database, unified);

	const tables = (database.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
	for (const dropped of ["provider_reports", "report_threads", "report_messages"]) expect(tables).not.toContain(dropped);
	expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);

	const reports = database.query("SELECT id, submission_id, idempotency_key, status, requester_ip FROM abuse_reports ORDER BY id").all() as Array<Record<string, unknown>>;
	expect(reports).toEqual([
		{ id: 1000n, submission_id: 1000n, idempotency_key: "submission:1000", status: "submitted", requester_ip: "8.8.8.8" },
		{ id: 1001n, submission_id: 1001n, idempotency_key: "submission:1001", status: "partially_submitted", requester_ip: "8.8.8.8" },
		{ id: 6000n, submission_id: 1002n, idempotency_key: "submission:1002", status: "partially_submitted", requester_ip: null },
		{ id: 7000n, submission_id: null, idempotency_key: "hermes-123", status: "waiting_provider", requester_ip: null },
	]);
	expect(database.query("SELECT normalized_target, target_type, observed_urls FROM abuse_targets WHERE report_id IN (1000, 1001) ORDER BY report_id, ordinal").all()).toEqual([
		{ normalized_target: "login.example.com", target_type: "domain", observed_urls: JSON.stringify(["https://Login.Example.com:8443/collect?x=1#frag"]) },
		{ normalized_target: "phishing-email", target_type: "email", observed_urls: "[]" },
		{ normalized_target: "149.72.231.44", target_type: "ip", observed_urls: "[]" },
	]);
	// The message goes to Netcraft; the abuse mailbox belongs to the sending IP.
	expect(database.query("SELECT r.id, t.normalized_target FROM abuse_provider_routes r JOIN abuse_targets t ON t.id = r.target_id WHERE r.report_id = 1001 ORDER BY r.id").all()).toEqual([
		{ id: 5100n, normalized_target: "phishing-email" },
		{ id: 5101n, normalized_target: "149.72.231.44" },
	]);

	const routes = database.query("SELECT id, report_id, provider_registry_key, route_type, verified_email, status FROM abuse_provider_routes ORDER BY id").all();
	expect(routes).toEqual([
		{ id: 2000n, report_id: 1000n, provider_registry_key: "email:host.example", route_type: "email", verified_email: "abuse@host.example", status: "acknowledged" },
		{ id: 5000n, report_id: 1000n, provider_registry_key: "historical:google_safe_browsing", route_type: "provider_submission", verified_email: null, status: "submitted" },
		{ id: 5100n, report_id: 1001n, provider_registry_key: "netcraft_mail", route_type: "provider_submission", verified_email: null, status: "submitted" },
		{ id: 5101n, report_id: 1001n, provider_registry_key: "email:sender.example", route_type: "email", verified_email: "abuse@sender.example", status: "provider_rejected" },
		{ id: 6002n, report_id: 6000n, provider_registry_key: "email:hostinger.example", route_type: "email", verified_email: "abuse@hostinger.example", status: "acknowledged" },
		{ id: 6003n, report_id: 6000n, provider_registry_key: "cloudflare", route_type: "provider_submission", verified_email: null, status: "unknown_external_state" },
	]);
	const runs = database.query("SELECT route_id, execution_status, confirmation_id, final_url, failure_reason, json_extract(provider_payload, '$.body') body FROM abuse_provider_runs ORDER BY route_id").all();
	expect(runs).toEqual([
		{ route_id: 5000n, execution_status: "completed", confirmation_id: null, final_url: null, failure_reason: null, body: "The URL is a phishing site." },
		{ route_id: 5100n, execution_status: "completed", confirmation_id: "dddddddddddddddddddddddddddddddd", final_url: "https://report.netcraft.com/api/v3/submission/dddddddddddddddddddddddddddddddd", failure_reason: null, body: "Original email submitted." },
		{ route_id: 5101n, execution_status: "failed", confirmation_id: null, final_url: null, failure_reason: "SMTP 550", body: "Sent by sender.example." },
	]);

	// Correspondence keeps its ids; the duplicated worker outbound mail is not copied twice.
	const mail = database.query("SELECT id, route_id, direction, classification, reply_address, raw_artifact_id FROM abuse_mail_messages ORDER BY id").all();
	expect(mail).toEqual([
		{ id: 4000n, route_id: 2000n, direction: "outbound", classification: null, reply_address: "case-a@phishing.support", raw_artifact_id: 3000n },
		{ id: 4001n, route_id: 2000n, direction: "inbound", classification: "acknowledged", reply_address: null, raw_artifact_id: 3001n },
		{ id: 4101n, route_id: 6002n, direction: "inbound", classification: "acknowledged", reply_address: null, raw_artifact_id: 3200n },
		{ id: 6004n, route_id: 6002n, direction: "outbound", classification: null, reply_address: "abuse-x@phishing.support", raw_artifact_id: null },
	]);
	const moved = database.query("SELECT id, report_id, kind, CAST(blob AS TEXT) blob FROM abuse_artifacts ORDER BY id").all();
	expect(moved).toEqual([
		{ id: 3000n, report_id: 1000n, kind: "outbound_mail_mime", blob: "outbound mime" },
		{ id: 3001n, report_id: 1000n, kind: "inbound_mail_mime", blob: "reply mime" },
		{ id: 3100n, report_id: 1001n, kind: "user_evidence_original", blob: "phishing mime" },
		{ id: 3200n, report_id: 6000n, kind: "inbound_mail_mime", blob: "hostinger reply" },
	]);
	// Submission evidence stays with the submission; correspondence moved to its report.
	expect(database.query("SELECT id, kind FROM artifacts ORDER BY id").all()).toEqual([
		{ id: 3002n, kind: "screenshot" },
		{ id: 3100n, kind: "eml" },
	]);
	expect(database.query("SELECT id, route FROM mail_ingest").all()).toEqual([{ id: 8000n, route: "reply" }]);
	expect((database.query("PRAGMA table_info(abuse_reports)").all() as Array<{ name: string }>).map((column) => column.name))
		.toEqual(expect.arrayContaining(["submission_id", "reporter_name"]));
	expect((database.query("PRAGMA table_info(abuse_reports)").all() as Array<{ name: string }>).map((column) => column.name)).not.toContain("reporter_identity");
	database.close();
});
