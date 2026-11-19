import type { SiteCheckState } from "@/lib/liveness/schema";
import type { ProviderRole } from "@/lib/provider_stats/role";
import type { RouteVerdict } from "@/lib/provider_stats/route_outcome";

export const ROLE_TITLE: Record<ProviderRole, string> = {
	registrar: "Registrars",
	host: "Hosting providers",
	cdn: "CDNs and proxies",
	blocklist: "Blocklists",
	email: "Email services",
	platform: "Platforms",
	authority: "Authorities",
	other: "Other contacts",
};

export const ROLE_LABEL: Record<ProviderRole, string> = {
	registrar: "registrar",
	host: "hosting",
	cdn: "CDN",
	blocklist: "blocklist",
	email: "email service",
	platform: "platform",
	authority: "authority",
	other: "other",
};

/** What a role can do, and so what its takedown rate counts. */
export const ROLE_MEASURE: Record<ProviderRole, string> = {
	registrar: "They can suspend the domain. Counted as their takedown: the domain stopped resolving, went on hold, or was parked.",
	host: "They can remove the site. Counted as their takedown: the page was removed, suspended or stopped answering while the domain still worked.",
	cdn: "They proxy the site and can put a phishing warning in front of it or name the real host. Counted as their takedown: their warning page.",
	blocklist: "They warn browsers and mail filters and pass reports on; they remove nothing themselves. Counted: the site went down by any means.",
	email: "The mail services phishing messages were sent through. Counted: the reported site went down by any means.",
	platform: "Services whose accounts the scams use. Counted: the reported site went down by any means.",
	authority: "Police and prosecutors receiving criminal complaints. Counted: the reported site went down by any means.",
	other: "Contacts whose part is unknown. Counted: the reported site went down by any means.",
};

export const VERDICT_LABEL: Record<RouteVerdict, string> = {
	acknowledged: "Acknowledged",
	rejected: "Rejected",
	not_monitored: "Mailbox not monitored",
	needs_more_information: "Asked for more",
	no_decision: "Answered, no decision",
	no_reply: "No reply",
	bounced: "Bounced",
	not_delivered: "Not filed",
	pending: "Being delivered",
};

/** Fill colours of the outcome bar, from good to bad. */
export const VERDICT_FILL: Record<RouteVerdict, string> = {
	acknowledged: "bg-emerald-500",
	no_decision: "bg-sky-400",
	needs_more_information: "bg-amber-400",
	no_reply: "bg-slate-300",
	rejected: "bg-red-500",
	not_monitored: "bg-rose-300",
	bounced: "bg-zinc-600",
	not_delivered: "bg-slate-100",
	pending: "bg-slate-100",
};

export const VERDICT_BADGE: Record<RouteVerdict, string> = {
	acknowledged: "border-emerald-200 bg-emerald-50 text-emerald-800",
	no_decision: "border-sky-200 bg-sky-50 text-sky-800",
	needs_more_information: "border-amber-200 bg-amber-50 text-amber-800",
	no_reply: "border-slate-200 bg-slate-50 text-slate-700",
	rejected: "border-red-200 bg-red-50 text-red-800",
	not_monitored: "border-rose-200 bg-rose-50 text-rose-800",
	bounced: "border-zinc-300 bg-zinc-100 text-zinc-800",
	not_delivered: "border-dashed border-slate-300 bg-background text-slate-500",
	pending: "border-dashed border-amber-300 bg-background text-amber-700",
};

export const SITE_STATE_LABEL: Record<SiteCheckState, string> = {
	online: "Online",
	redirected: "Redirects elsewhere",
	unreachable: "Not answering",
	removed: "Page removed",
	host_suspended: "Suspended by host",
	cdn_blocked: "Behind CDN warning",
	parked: "Parked",
	domain_suspended: "Domain on hold",
	domain_gone: "Domain deleted",
};

/** A duration in minutes, short: "45 min", "5 h", "3.5 d". */
export function formatMinutes(minutes: number | undefined): string {
	if (minutes === undefined) return "—";
	if (minutes < 60) return `${minutes} min`;
	if (minutes < 48 * 60) return `${Math.round(minutes / 6) / 10} h`.replace(".0 h", " h");
	return `${Math.round(minutes / 144) / 10} d`.replace(".0 d", " d");
}

/** A share as "42 %", or a dash without a base. */
export function formatPercent(value: number | undefined): string {
	return value === undefined ? "—" : `${value} %`;
}

export function formatDay(date: Date): string {
	return date.toISOString().slice(0, 10);
}
