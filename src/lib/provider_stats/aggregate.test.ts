import { describe, expect, test } from "bun:test";

import type { Takedown } from "../liveness/layer";
import { distributionOf, LOW_DATA_THRESHOLD, percent, providerStatsOf, routeTakedownOf, statsOf, type ProviderRouteRecord } from "./aggregate";
import type { ProviderRole } from "./role";
import type { RouteOutcome } from "./route_outcome";
import { overviewOf, providerDetailOf, reportFeedOf, reportFilterOf, pageOf, siteStateOf, PAGE_SIZE } from "./views";
import type { ReportSummary } from "./repository";

const at = (hours: number) => new Date(Date.UTC(2026, 0, 1) + hours * 3_600_000);
const outcome = (overrides: Partial<RouteOutcome> = {}): RouteOutcome => ({ verdict: "no_reply", sentAt: at(0), followUps: 0, unansweredDecisions: 0, overturnedByFollowUp: false, inbound: 0, outbound: 1, ...overrides });
let nextId = 1n;
const record = (overrides: Partial<ProviderRouteRecord> & { slug?: string; role?: ProviderRole } = {}): ProviderRouteRecord => {
	const { slug = "acme", ...rest } = overrides;
	const id = nextId++;
	return {
		routeId: id,
		reportId: id,
		submissionId: null,
		target: `site${id}.example`,
		targetType: "domain",
		organisation: { slug, name: slug.toUpperCase() },
		role: "host",
		channel: "email",
		reportedAt: at(-1),
		outcome: outcome(),
		...rest,
	};
};
const down = (hours: number, layer: Takedown["layer"], exactTime = true): Takedown => ({ downAt: at(hours), lastOnlineAt: at(-1), layer, state: "removed", stillOnline: false, exactTime });
const online: Takedown = { lastOnlineAt: at(0), stillOnline: true, exactTime: false, state: "online" };

describe("routeTakedownOf", () => {
	test("a host is credited with a host takedown after it got the report, with the time it took", () => {
		expect(routeTakedownOf({ role: "host", outcome: outcome(), takedown: down(5, "host") })).toEqual({ siteDown: true, byThisLayer: true, minutes: 300 });
	});

	test("a registrar is not credited with what the host did, and the reverse", () => {
		expect(routeTakedownOf({ role: "registrar", outcome: outcome(), takedown: down(5, "host") })).toEqual({ siteDown: true, byThisLayer: false, minutes: 300 });
		expect(routeTakedownOf({ role: "host", outcome: outcome(), takedown: down(5, "registrar") })?.byThisLayer).toBe(false);
		expect(routeTakedownOf({ role: "cdn", outcome: outcome(), takedown: down(5, "cdn") })?.byThisLayer).toBe(true);
	});

	test("roles that control no layer are credited with any takedown", () => {
		for (const role of ["blocklist", "authority", "email", "platform", "other"] as const) {
			expect(routeTakedownOf({ role, outcome: outcome(), takedown: down(1, "registrar") })?.byThisLayer).toBe(true);
		}
	});

	test("a site that was down before the provider got the report is no credit to it", () => {
		expect(routeTakedownOf({ role: "host", outcome: outcome({ sentAt: at(10) }), takedown: down(5, "host") })).toEqual({ siteDown: false, byThisLayer: false });
	});

	test("an upper-bound takedown time counts the takedown but not its time", () => {
		expect(routeTakedownOf({ role: "host", outcome: outcome(), takedown: down(500, "host", false) })).toEqual({ siteDown: true, byThisLayer: true });
	});

	test("no check, or a report never delivered, is no takedown record at all", () => {
		expect(routeTakedownOf({ role: "host", outcome: outcome() })).toBeUndefined();
		expect(routeTakedownOf({ role: "host", outcome: outcome({ verdict: "not_delivered", sentAt: undefined }), takedown: down(1, "host") })).toBeUndefined();
	});

	test("a site still online has no takedown", () => {
		expect(routeTakedownOf({ role: "host", outcome: outcome(), takedown: online })).toEqual({ siteDown: false, byThisLayer: false });
	});
});

describe("distributionOf", () => {
	test("nearest-rank quartiles are values that happened", () => {
		expect(distributionOf([40, 10, 30, 20])).toEqual({ count: 4, median: 20, p25: 10, p75: 30, values: [10, 20, 30, 40] });
		expect(distributionOf([7])).toEqual({ count: 1, median: 7, p25: 7, p75: 7, values: [7] });
		expect(distributionOf([])).toEqual({ count: 0, values: [] });
	});
});

describe("statsOf", () => {
	test("rates are over delivered reports only; our failures and work in flight are counted apart", () => {
		const stats = statsOf([
			record({ outcome: outcome({ verdict: "acknowledged", firstReplyAt: at(1), decisionAt: at(2) }), takedown: down(3, "host") }),
			record({ outcome: outcome({ verdict: "rejected", firstReplyAt: at(4), decisionAt: at(4), followUps: 2, unansweredDecisions: 1 }), takedown: online }),
			record({ outcome: outcome({ verdict: "acknowledged", followUps: 1, overturnedByFollowUp: true, firstReplyAt: at(10), decisionAt: at(10) }), takedown: down(400, "host", false) }),
			record({ outcome: outcome({ verdict: "no_reply" }) }),
			record({ outcome: outcome({ verdict: "not_delivered", sentAt: undefined }), takedown: down(1, "host") }),
			record({ outcome: outcome({ verdict: "pending", sentAt: undefined }) }),
		], { slug: "acme", name: "ACME" }, "host");
		expect(stats).toMatchObject({
			routes: 6,
			delivered: 4,
			notDelivered: 1,
			pending: 1,
			verdicts: { acknowledged: 2, rejected: 1, no_reply: 1, not_delivered: 1, pending: 1 },
			checked: 3,
			takenDown: 2,
			siteDown: 2,
			followUps: 3,
			overturned: 1,
			unansweredDecisions: 1,
		});
		expect(stats.replyMinutes).toMatchObject({ count: 3, median: 240 });
		expect(stats.decisionMinutes.values).toEqual([120, 240, 600]);
		// Only the exactly timed takedown has a duration.
		expect(stats.takedownMinutes.values).toEqual([180]);
	});

	test("a takedown by another layer counts as the site going down, not as this provider's takedown", () => {
		const stats = statsOf([record({ role: "registrar", takedown: down(2, "host") })], { slug: "r", name: "R" }, "registrar");
		expect(stats).toMatchObject({ checked: 1, siteDown: 1, takenDown: 0 });
		expect(stats.takedownMinutes.count).toBe(0);
	});

	test("the report period spans the group's first and last report", () => {
		const stats = statsOf([record({ reportedAt: at(5) }), record({ reportedAt: at(-30) }), record({ reportedAt: at(2) })], { slug: "a", name: "A" }, "host");
		expect(stats.firstReportAt).toEqual(at(-30));
		expect(stats.lastReportAt).toEqual(at(5));
	});
});

describe("providerStatsOf", () => {
	test("one row per company and role, most delivered reports first", () => {
		const rows = providerStatsOf([
			record({ slug: "small" }),
			record({ slug: "big" }), record({ slug: "big" }), record({ slug: "big", role: "registrar" }),
			record({ slug: "failing", outcome: outcome({ verdict: "not_delivered", sentAt: undefined }) }), record({ slug: "failing", outcome: outcome({ verdict: "not_delivered", sentAt: undefined }) }),
		]);
		expect(rows.map((row) => [row.organisation.slug, row.role, row.delivered, row.routes])).toEqual([
			["big", "host", 2, 2],
			["big", "registrar", 1, 1],
			["small", "host", 1, 1],
			["failing", "host", 0, 2],
		]);
	});

	test("percent rounds and has no value without a base", () => {
		expect(percent(1, 3)).toBe(33);
		expect(percent(0, 0)).toBeUndefined();
		expect(LOW_DATA_THRESHOLD).toBeGreaterThan(1);
	});
});

const summary = (reportId: bigint, hours: number, overrides: Partial<ReportSummary> = {}): ReportSummary => ({ reportId, submissionId: null, status: "submitted", allegationCategory: "phishing", createdAt: at(hours), targets: [`site${reportId}.example`], ...overrides });

describe("views", () => {
	test("the overview ranks providers within each role, in the fixed role order, and counts sites once", () => {
		const records = [
			record({ slug: "netcraft", role: "blocklist", reportId: 1n, target: "a.example", takedown: down(1, "registrar") }),
			record({ slug: "registrar-x", role: "registrar", reportId: 1n, target: "a.example", takedown: down(1, "registrar") }),
			record({ slug: "host-y", role: "host", reportId: 2n, target: "b.example", takedown: online }),
		];
		const overview = overviewOf({ records, reports: [summary(1n, 0), summary(2n, 1), summary(3n, 2)] });
		expect(overview.roles.map((entry) => entry.role)).toEqual(["registrar", "host", "blocklist"]);
		expect(overview.roles[0]!.total).toMatchObject({ delivered: 1, takenDown: 1 });
		expect(overview).toMatchObject({ reports: 3, providers: 3, sitesChecked: 2, sitesDown: 1 });
	});

	test("a provider's detail has a row per role it played and its routes newest first", () => {
		const records = [
			record({ slug: "cloudflare", role: "cdn", reportedAt: at(1) }),
			record({ slug: "cloudflare", role: "registrar", reportedAt: at(3) }),
			record({ slug: "other", reportedAt: at(9) }),
		];
		const detail = providerDetailOf({ records, reports: [] }, "cloudflare")!;
		expect(detail.stats.map((row) => row.role).sort()).toEqual(["cdn", "registrar"]);
		expect(detail.records.map((entry) => entry.reportedAt)).toEqual([at(3), at(1)]);
		expect(providerDetailOf({ records, reports: [] }, "nobody")).toBeUndefined();
	});

	test("the report feed lists every report, also those no provider was reached for, and filters by a matching route", () => {
		const records = [
			record({ reportId: 1n, slug: "netcraft", role: "blocklist", outcome: outcome({ verdict: "acknowledged" }), takedown: down(2, "registrar") }),
			record({ reportId: 1n, slug: "host-y", role: "host", outcome: outcome({ verdict: "rejected" }), takedown: down(2, "registrar") }),
			record({ reportId: 2n, slug: "host-y", role: "host", outcome: outcome({ verdict: "no_reply" }), takedown: online }),
		];
		const dataset = { records, reports: [summary(3n, 5), summary(2n, 4), summary(1n, 3)] };
		expect(reportFeedOf(dataset, {}, 1).entries.map((entry) => [entry.reportId, entry.routes.length])).toEqual([[3n, 0], [2n, 1], [1n, 2]]);
		// Role and verdict must hold for the same route: report 1's host rejected, its blocklist accepted.
		expect(reportFeedOf(dataset, { role: "host", verdict: "acknowledged" }, 1).total).toBe(0);
		expect(reportFeedOf(dataset, { role: "host", verdict: "rejected" }, 1).entries.map((entry) => entry.reportId)).toEqual([1n]);
		expect(reportFeedOf(dataset, { provider: "host-y" }, 1).total).toBe(2);
		expect(reportFeedOf(dataset, { site: "down" }, 1).entries.map((entry) => entry.reportId)).toEqual([1n]);
		expect(reportFeedOf(dataset, { site: "online" }, 1).entries.map((entry) => entry.reportId)).toEqual([2n]);
		expect(reportFeedOf(dataset, { site: "unchecked" }, 1).entries.map((entry) => entry.reportId)).toEqual([3n]);
	});

	test("the feed pages are clamped to the pages that exist", () => {
		const reports = Array.from({ length: PAGE_SIZE + 3 }, (_, index) => summary(BigInt(index + 1), -index));
		expect(reportFeedOf({ records: [], reports }, {}, 2)).toMatchObject({ page: 2, pageCount: 2, total: PAGE_SIZE + 3 });
		expect(reportFeedOf({ records: [], reports }, {}, 2).entries).toHaveLength(3);
		expect(reportFeedOf({ records: [], reports }, {}, 99).page).toBe(2);
		expect(reportFeedOf({ records: [], reports: [] }, {}, 1)).toMatchObject({ page: 1, pageCount: 1, total: 0 });
	});

	test("filters and pages from search parameters accept only known values", () => {
		expect(reportFilterOf({ role: "host", verdict: "rejected", provider: "cloudflare", site: "down" })).toEqual({ role: "host", verdict: "rejected", provider: "cloudflare", site: "down" });
		expect(reportFilterOf({ role: "admin", verdict: ["rejected"], provider: "../etc", site: "maybe" })).toEqual({});
		expect([pageOf("3"), pageOf("0"), pageOf("-1"), pageOf("abc"), pageOf(undefined), pageOf(["2"])]).toEqual([3, 1, 1, 1, 1, 1]);
	});

	test("a site that went down and came back is online", () => {
		expect(siteStateOf([record({ takedown: { downAt: at(1), lastOnlineAt: at(0), layer: "host", stillOnline: true, exactTime: true, state: "online" } })])).toBe("online");
		expect(siteStateOf([record({})])).toBe("unchecked");
	});
});
