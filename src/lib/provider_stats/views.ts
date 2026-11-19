import { getReportsByIds } from "../submissions/abuse_details";
import type { SubmissionReport, SubmissionReportRoute } from "../submissions/abuse_details";
import { providerStatsOf, statsOf, type ProviderRouteRecord, type ProviderStats } from "./aggregate";
import type { Organisation } from "./organisation";
import { providerDataset, type ProviderDataset, type ReportSummary } from "./repository";
import { providerRoles, type ProviderRole } from "./role";
import { routeVerdicts, type RouteVerdict } from "./route_outcome";

export const PAGE_SIZE = 25;

export type RoleOverview = { role: ProviderRole; total: ProviderStats; providers: ProviderStats[] };

export type ProviderOverview = {
	roles: RoleOverview[];
	reports: number;
	providers: number;
	/** Sites with at least one liveness check, and how many of them are down now. */
	sitesChecked: number;
	sitesDown: number;
};

/** The leaderboard: every provider ranked within its role, roles in a fixed order, empty roles left out. */
export function overviewOf(dataset: ProviderDataset): ProviderOverview {
	const stats = providerStatsOf(dataset.records);
	const roles = providerRoles.flatMap((role) => {
		const providers = stats.filter((entry) => entry.role === role);
		if (!providers.length) return [];
		const records = dataset.records.filter((record) => record.role === role);
		return [{ role, total: statsOf(records, { slug: role, name: role }, role), providers }];
	});
	// One site per reported target; its state is the latest check, the same for every route of the target.
	const sites = new Map<string, ProviderRouteRecord["takedown"]>();
	for (const record of dataset.records) if (record.takedown) sites.set(record.target, record.takedown);
	return {
		roles,
		reports: dataset.reports.length,
		providers: new Set(stats.map((entry) => entry.organisation.slug)).size,
		sitesChecked: sites.size,
		sitesDown: [...sites.values()].filter((takedown) => takedown?.downAt && !takedown.stillOnline).length,
	};
}

export type ProviderDetail = {
	organisation: Organisation;
	/** One entry per role the provider played. */
	stats: ProviderStats[];
	/** Its routes, newest first. */
	records: ProviderRouteRecord[];
};

export function providerDetailOf(dataset: ProviderDataset, slug: string): ProviderDetail | undefined {
	const records = dataset.records.filter((record) => record.organisation.slug === slug).sort((a, b) => b.reportedAt.getTime() - a.reportedAt.getTime());
	if (!records.length) return undefined;
	return { organisation: records[0]!.organisation, stats: providerStatsOf(records), records };
}

/** A provider page address as `slugify` makes them; anything else names no provider. */
export function isProviderSlug(value: string): boolean {
	return /^[a-z0-9-]{1,120}$/.test(value);
}

export type ReportFilter = { role?: ProviderRole; verdict?: RouteVerdict; provider?: string; site?: "down" | "online" | "unchecked" };

/** Read a filter from search parameters, ignoring values that are not one of the known ones. */
export function reportFilterOf(params: Record<string, string | string[] | undefined>): ReportFilter {
	const one = (key: string) => (typeof params[key] === "string" ? params[key] : undefined);
	const role = one("role"), verdict = one("verdict"), provider = one("provider"), site = one("site");
	return {
		...(role && (providerRoles as readonly string[]).includes(role) ? { role: role as ProviderRole } : {}),
		...(verdict && (routeVerdicts as readonly string[]).includes(verdict) ? { verdict: verdict as RouteVerdict } : {}),
		...(provider && isProviderSlug(provider) ? { provider } : {}),
		...(site === "down" || site === "online" || site === "unchecked" ? { site } : {}),
	};
}

export type ReportFeedEntry = ReportSummary & { routes: ProviderRouteRecord[] };

/** The reported site's state now: down when every checked target is down, online when one is up, or never checked. */
export function siteStateOf(routes: readonly ProviderRouteRecord[]): "down" | "online" | "unchecked" {
	const takedowns = routes.flatMap((route) => (route.takedown ? [route.takedown] : []));
	if (!takedowns.length) return "unchecked";
	return takedowns.every((takedown) => takedown.downAt && !takedown.stillOnline) ? "down" : "online";
}

/** Every report, newest first, each with its provider routes; a filter keeps reports with a route that matches it. */
export function reportFeedOf(dataset: ProviderDataset, filter: ReportFilter, page: number): { entries: ReportFeedEntry[]; total: number; pageCount: number; page: number } {
	const routesByReport = Map.groupBy(dataset.records, (record) => record.reportId);
	const routeFilter = filter.role || filter.verdict || filter.provider;
	const entries = dataset.reports
		.map((report) => ({ ...report, routes: routesByReport.get(report.reportId) ?? [] }))
		.filter((entry) => !routeFilter || entry.routes.some((route) =>
			(!filter.role || route.role === filter.role)
			&& (!filter.verdict || route.outcome.verdict === filter.verdict)
			&& (!filter.provider || route.organisation.slug === filter.provider)))
		.filter((entry) => !filter.site || siteStateOf(entry.routes) === filter.site);
	const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
	const current = Math.min(Math.max(1, page), pageCount);
	return { entries: entries.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE), total: entries.length, pageCount, page: current };
}

/** A page number from a search parameter: a positive integer, else the first page. */
export function pageOf(value: string | string[] | undefined): number {
	const page = typeof value === "string" && /^\d{1,6}$/.test(value) ? Number(value) : 1;
	return Math.max(1, page);
}

export async function getProviderOverview(): Promise<ProviderOverview> {
	return overviewOf(await providerDataset());
}

export type ProviderRouteDetail = { record: ProviderRouteRecord; report: SubmissionReport; route: SubmissionReportRoute };

/** A provider's statistics and one page of its routes with their full correspondence. */
export async function getProviderPage(slug: string, page: number): Promise<(ProviderDetail & { page: number; pageCount: number; routes: ProviderRouteDetail[] }) | undefined> {
	const detail = providerDetailOf(await providerDataset(), slug);
	if (!detail) return undefined;
	const pageCount = Math.max(1, Math.ceil(detail.records.length / PAGE_SIZE));
	const current = Math.min(page, pageCount);
	const slice = detail.records.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
	const reports = new Map((await getReportsByIds([...new Set(slice.map((record) => record.reportId))])).map((report) => [report.id, report]));
	const routes = slice.flatMap((record) => {
		const report = reports.get(record.reportId);
		const route = report?.routes.find((candidate) => candidate.id === record.routeId);
		return report && route ? [{ record, report, route }] : [];
	});
	return { ...detail, page: current, pageCount, routes };
}

export async function getReportFeed(filter: ReportFilter, page: number) {
	const dataset = await providerDataset();
	return { ...reportFeedOf(dataset, filter, page), organisations: organisationsOf(dataset) };
}

/** Every organisation with routes, by name, for the provider filter. */
function organisationsOf(dataset: ProviderDataset): Organisation[] {
	const bySlug = new Map(dataset.records.map((record) => [record.organisation.slug, record.organisation]));
	return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name));
}
