import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { validateAbuseReportRequest } from "../abuse/contracts";
import { AbuseRepository } from "../abuse/repository";
import { abuseEvents, abuseMailMessages, abuseProviderRoutes, abuseReports, siteChecks, type AbuseRouteStatus, type AbuseRouteType, type SiteCheckState } from "../db/schema";
import { getDb } from "../db";
import { generateId } from "../db/ids";
import { useTemporaryDatabase } from "../db/test_helpers";
import { overviewOf, providerDetailOf, reportFeedOf } from "./views";
import { loadProviderRouteRecords, loadReportSummaries, providerDataset } from "./repository";

const HOUR = 3_600_000;

describe("provider statistics from the database", () => {
	useTemporaryDatabase();

	async function report(target: string, createdAt: Date) {
		const request = await validateAbuseReportRequest({ targets: [target], allegationCategory: "phishing", description: `Phishing at ${target}.` });
		const created = await AbuseRepository.createReport({ request, reporter: {} });
		const db = await getDb();
		db.update(abuseReports).set({ createdAt }).where(eq(abuseReports.id, created.reportId)).run();
		const [targetRow] = await AbuseRepository.listTargets(created.reportId);
		return { reportId: created.reportId, targetId: targetRow!.id };
	}

	async function route(owner: { reportId: bigint; targetId: bigint }, params: { key: string; type: AbuseRouteType; status: AbuseRouteStatus; email?: string; source?: string; name?: string }) {
		const id = generateId();
		(await getDb()).insert(abuseProviderRoutes).values({
			id,
			reportId: owner.reportId,
			targetId: owner.targetId,
			routeKey: `${params.key}:${id}`,
			providerRegistryKey: params.key,
			providerDisplayName: params.name ?? "Abuse-C Role",
			routeType: params.type,
			verifiedEmail: params.email ?? null,
			resolverProvenance: params.source ? { source: params.source } : {},
			resolutionSnapshot: {},
			status: params.status,
		}).run();
		return id;
	}

	async function mail(owner: { reportId: bigint }, routeId: bigint, params: { direction: "inbound" | "outbound"; kind: string; status?: string; classification?: "acknowledged" | "rejected" | null; at: Date; correlationKey?: string; body?: string }) {
		(await getDb()).insert(abuseMailMessages).values({
			id: generateId(), reportId: owner.reportId, routeId, direction: params.direction, kind: params.kind, status: params.status ?? (params.direction === "outbound" ? "sent" : "received"),
			classification: params.classification ?? null, correlationKey: params.correlationKey ?? null, textBody: params.body ?? "text", occurredAt: params.at,
		}).run();
	}

	async function event(owner: { reportId: bigint }, routeId: bigint, eventType: string, data: Record<string, unknown>, at: Date) {
		(await getDb()).insert(abuseEvents).values({ id: generateId(), reportId: owner.reportId, routeId, eventType, data, createdAt: at }).run();
	}

	async function check(owner: { reportId: bigint; targetId: bigint }, state: SiteCheckState, at: Date) {
		(await getDb()).insert(siteChecks).values({ id: generateId(), reportId: owner.reportId, targetId: owner.targetId, url: "https://x.example/", state, checkedAt: at }).run();
	}

	test("routes become records with their company, role, outcome and the takedown of their site", async () => {
		const t0 = new Date(Date.UTC(2026, 5, 1));
		const at = (hours: number) => new Date(t0.getTime() + hours * HOUR);
		const first = await report("bad-bank-login.com", t0);

		const registrar = await route(first, { key: "email:namecheap.com", type: "email", status: "provider_rejected", email: "abuse@namecheap.com", source: "registrar_rdap" });
		await mail(first, registrar, { direction: "outbound", kind: "report", at: at(0.1), correlationKey: "email-run:1" });
		await mail(first, registrar, { direction: "inbound", kind: "reply", classification: "rejected", at: at(5) });
		await mail(first, registrar, { direction: "outbound", kind: "report", at: at(6), correlationKey: `decision-follow-up:${registrar}:x` });
		await event(first, registrar, "route.status_changed", { from: "running", to: "awaiting_provider_reply" }, at(0.1));
		await event(first, registrar, "route.status_changed", { from: "awaiting_provider_reply", to: "provider_rejected" }, at(5));

		const cdn = await route(first, { key: "cloudflare", type: "provider_submission", status: "submitted", source: "domain_infrastructure_ip", name: "Cloudflare Abuse" });
		await event(first, cdn, "route.status_changed", { from: "running", to: "submitted" }, at(0.2));
		await mail(first, cdn, { direction: "inbound", kind: "provider_api", classification: "acknowledged", at: at(2) });
		await event(first, cdn, "provider_decision.not_answered", { state: "denied" }, at(3));

		await route(first, { key: "netcraft", type: "provider_submission", status: "unknown_external_state", source: "provider_supplemental_target_rule" });
		await route(first, { key: "manual_unroutable", type: "manual_unroutable", status: "no_route" });

		// A contact reached after the site was already down says nothing about takedowns.
		const late = await route(first, { key: "email:example-host.net", type: "email", status: "awaiting_provider_reply", email: "abuse@example-host.net", source: "ip_rdap" });
		await mail(first, late, { direction: "outbound", kind: "report", at: at(30), correlationKey: "email-run:2" });

		await check(first, "online", at(1));
		await check(first, "cdn_blocked", at(6));
		await check(first, "cdn_blocked", at(24));

		const second = await report("other-site.com", at(48));
		const records = await loadProviderRouteRecords();
		expect(records).toHaveLength(4);
		expect(records.find((record) => record.routeId === late)).toMatchObject({ role: "host", outcome: { verdict: "no_reply", sentAt: at(30) } });
		expect(records.find((record) => record.routeId === late)!.takedown).toBeUndefined();
		const byKey = new Map(records.map((record) => [record.organisation.slug, record]));

		expect(byKey.get("namecheap")).toMatchObject({
			role: "registrar",
			channel: "email",
			target: "bad-bank-login.com",
			outcome: { verdict: "rejected", sentAt: at(0.1), decisionAt: at(5), followUps: 1, inbound: 1, outbound: 2 },
			takedown: { downAt: at(6), layer: "cdn", stillOnline: false, exactTime: true },
		});
		expect(byKey.get("cloudflare")).toMatchObject({ role: "cdn", outcome: { verdict: "acknowledged", sentAt: at(0.2), firstReplyAt: at(2), unansweredDecisions: 1 } });
		expect(byKey.get("netcraft")).toMatchObject({ role: "blocklist", outcome: { verdict: "not_delivered" } });

		const dataset = { records, reports: await loadReportSummaries() };
		expect(dataset.reports.map((summary) => [summary.reportId, summary.targets])).toEqual([[second.reportId, ["other-site.com"]], [first.reportId, ["bad-bank-login.com"]]]);

		const overview = overviewOf(dataset);
		expect(overview.roles.map((entry) => entry.role)).toEqual(["registrar", "host", "cdn", "blocklist"]);
		expect(overview.roles.find((entry) => entry.role === "host")!.total).toMatchObject({ delivered: 1, checked: 0 });
		// The CDN's warning is its own takedown; the registrar is not credited with it.
		expect(overview.roles.find((entry) => entry.role === "cdn")!.total).toMatchObject({ takenDown: 1, checked: 1 });
		expect(overview.roles.find((entry) => entry.role === "registrar")!.total).toMatchObject({ takenDown: 0, siteDown: 1, checked: 1 });
		expect(overview).toMatchObject({ reports: 2, sitesChecked: 1, sitesDown: 1 });
		expect(providerDetailOf(dataset, "cloudflare")!.stats[0]).toMatchObject({ delivered: 1, takenDown: 1, takedownMinutes: { values: [348] } });
		expect(reportFeedOf(dataset, { verdict: "not_delivered" }, 1).entries.map((entry) => entry.reportId)).toEqual([first.reportId]);
	});

	test("the dataset is loaded once per cache period and again after it", async () => {
		const first = await providerDataset(1_000_000);
		expect(await providerDataset(1_000_000 + 60_000)).toBe(first);
		expect(await providerDataset(1_000_000 + 6 * 60_000)).not.toBe(first);
	});
});

describe("migration 0021", () => {
	test("classifies the review states already read from Cloudflare and Eranet, and nothing else", () => {
		const database = new Database(":memory:");
		database.exec("CREATE TABLE abuse_provider_routes (id integer PRIMARY KEY, provider_registry_key text NOT NULL)");
		database.exec("CREATE TABLE abuse_mail_messages (id integer PRIMARY KEY, route_id integer, kind text NOT NULL, subject text, classification text, text_body text)");
		database.exec("CREATE TABLE abuse_reports (id integer PRIMARY KEY); CREATE TABLE abuse_targets (id integer PRIMARY KEY)");
		database.exec("INSERT INTO abuse_provider_routes VALUES (1, 'cloudflare'), (2, 'eranet'), (3, 'netcraft'), (4, 'email:example.com')");
		const noThreats = "The submission you made to report.netcraft.com on 01-Nov-2026 at 05:57 UTC has been automatically analysed, and no threats\nwere found.";
		const rows: Array<[number, number, string, string, string | null, string]> = [
			[1, 1, "provider_api", "Report status: accepted", null, ""],
			[2, 1, "provider_api", "Report status: denied", null, ""],
			[3, 1, "provider_api", "Report status: pending", null, ""],
			[4, 1, "provider_api", "Some email", null, ""],
			[5, 2, "provider_api", "Report status: supplement required", null, ""],
			[6, 2, "provider_api", "Report status: process completed", null, ""],
			[7, 2, "provider_api", "Report status: submitted", null, ""],
			[8, 3, "provider_api", "Report status: accepted", null, ""],
			[9, 4, "reply", "Report status: denied", null, ""],
			[10, 1, "provider_api", "Report status: denied", "acknowledged", ""],
			[11, 3, "notification", "We've finished analysing your submission", "acknowledged", noThreats],
			[12, 3, "notification", "We've finished analysing your submission", "acknowledged", "has been automatically analysed, and has been classified as malicious."],
			[13, 3, "notification", "Thanks for your report", "acknowledged", "Thanks for your report"],
			[14, 4, "notification", "Analysis", "acknowledged", noThreats],
			[15, 3, "notification", "We've finished analysing your submission", "acknowledged", "analysed, and no\r\nthreats were found."],
		];
		const insert = database.query("INSERT INTO abuse_mail_messages VALUES (?, ?, ?, ?, ?, ?)");
		for (const row of rows) insert.run(...row);
		const source = readFileSync(join(process.cwd(), "drizzle", "0021_site_checks_and_review_verdicts.sql"), "utf-8");
		for (const statement of source.split("--> statement-breakpoint")) if (statement.trim()) database.exec(statement);
		expect(database.query("SELECT id, classification FROM abuse_mail_messages ORDER BY id").all()).toEqual([
			{ id: 1, classification: "acknowledged" },
			{ id: 2, classification: "rejected" },
			{ id: 3, classification: null },
			{ id: 4, classification: null },
			{ id: 5, classification: "needs_more_information" },
			{ id: 6, classification: "acknowledged" },
			{ id: 7, classification: null },
			{ id: 8, classification: null },
			{ id: 9, classification: null },
			// An existing classification is kept.
			{ id: 10, classification: "acknowledged" },
			// Netcraft's "no threats were found" is its rejection, even across a line break; its other mails stay.
			{ id: 11, classification: "rejected" },
			{ id: 12, classification: "acknowledged" },
			{ id: 13, classification: "acknowledged" },
			// Another provider's mail with the same words is not Netcraft's verdict.
			{ id: 14, classification: "acknowledged" },
			{ id: 15, classification: "rejected" },
		]);
	});
});
