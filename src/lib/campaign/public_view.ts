import { getDomain } from "tldts";

import { withoutBackendSecrets } from "../exfiltration/secrets";
import { defangCommand } from "../malware/defang";
import { buildDossier, type Dossier, type DossierDependencies, type DossierSite } from "../referral/dossier";
import { record, text } from "../util/values";
import { CANARY_FIELD_LABEL, type CanaryField } from "../website/types";
import { campaignBrand, sameBrand, type GuidancePurpose, type VisitorGuidance } from "./guidance";
import { campaignVisitorKinds, type VisitorKind } from "./kinds";
import { factsFromDossier } from "./link";
import { comparePages, memberKey, screenshotPage } from "./members";
import { CampaignRepository } from "./repository";
import { operatorServerRoles } from "./schema";
import { fallbackDescription } from "./summary";
import type { ProviderRole } from "../provider_stats/role";
import { getReportsByIds, type SubmissionReport } from "../submissions/abuse_details";
import { nextStep, rankedRoutes, takedownSummary, type RouteBucket, type RouteStanding } from "../submissions/report_view";
import type { HostMove } from "../liveness/moves";

export type { GuidancePurpose } from "./guidance";
export type { VisitorKind } from "./kinds";

/**
 * Everything the public page of a campaign shows, derived from stored data
 * for every campaign alike: a heading written from the sites' analyses, the
 * sites with previews and takedown history, why they belong together, and
 * the full technical record: everything the authorities get, including the
 * bot tokens and accounts the operators published on their own pages.
 */
/**
 * One provider's report about a site, as the case page's Reports tab reads
 * it (`routeStanding`, `nextStep`): who, in which role, where it stands in
 * plain words with the provider's key sentence, and what happens next. No
 * correspondence leaves the server.
 */
export type PublicSiteReport = {
	routeId: string;
	organisation: string;
	/** Our copy of the company's website icon, or none yet. */
	icon: string | null;
	role: ProviderRole;
	channel: string;
	bucket: RouteBucket;
	label: string;
	line?: string;
	quoted: boolean;
	at?: string;
	sentAt?: string;
	steps: RouteStanding["steps"];
	next?: string;
	ticket?: string;
};

/**
 * How far the takedown of a site got: a host, registrar, CDN or platform
 * acted on it (`taken_down`); only a blocklist did, so browsers warn but the
 * site is up (`blocklisted`); a report reached a provider (`reported`);
 * every report failed to go out (`problem`); none was made (`none`).
 */
export type SiteTakedown = "taken_down" | "blocklisted" | "reported" | "problem" | "none";

const REMOVING_ROLES: ReadonlySet<ProviderRole> = new Set(["registrar", "host", "cdn", "platform"]);

export function siteTakedown(reports: readonly Pick<PublicSiteReport, "role" | "bucket">[]): SiteTakedown {
	const acted = reports.filter((report) => report.bucket === "action_taken");
	if (acted.some((report) => REMOVING_ROLES.has(report.role))) return "taken_down";
	if (acted.length) return "blocklisted";
	if (reports.some((report) => report.bucket !== "not_sent")) return "reported";
	return reports.length ? "problem" : "none";
}

export type PublicCampaignSite = {
	/** Unique on the page: a case can be a member for two sites, and two cases for one site. */
	key: string;
	submissionId: string;
	url: string;
	host: string;
	firstSeenAt: string;
	language?: string;
	thumbnailUrl?: string;
	screenshotUrl?: string;
	/** The judged page's screenshot is one flat colour, useless as a picture. */
	blankCapture: boolean;
	asks: string[];
	/** Every page of the site the visit captured, in the order shown: the landing page, the forms, the pages after them. */
	steps: Array<{ step: number; screenshotUrl: string; stampedUrl?: string }>;
	/** Why the page was judged phishing: the page's own words and the fields it collects with. */
	verdict?: { finding: string; basis?: string; quote?: string; impersonates?: string; fields: string[] };
	/** Where the synthetic values our visit entered went. */
	sent: Array<{ url: string; method: string; fields: string[]; sameSite: boolean }>;
	/** The site report's provider routes, strongest standing first. */
	reports: PublicSiteReport[];
	evidence: Array<{ name: string; size: number; sha256: string; url: string }>;
	takedown: SiteTakedown;
	/**
	 * Where the site moved after it was reported, while it still serves what
	 * was reported there and no provider acted since: said with `hostMoveText`,
	 * as the case page says it. Its takedown is then only `reported`: the
	 * action it moved away from shows as bypassed.
	 */
	moved?: PublicSiteMove;
};

export type PublicSiteMove = Pick<HostMove, "at" | "kind" | "content"> & { to: Pick<HostMove["to"], "name" | "asn" | "cdn">; allegation: string };

/** The site's move as the case page's takedown status reads it (`takedownSummary`), with only what the page shows. */
function publicSiteMove(reports: readonly SubmissionReport[]): PublicSiteMove | undefined {
	const moved = takedownSummary(reports).moved;
	if (!moved) return undefined;
	const { move, report } = moved;
	return {
		at: move.at,
		kind: move.kind,
		content: move.content,
		to: { name: move.to.name, ...(move.to.asn !== undefined ? { asn: move.to.asn } : {}), ...(move.to.cdn ? { cdn: move.to.cdn } : {}) },
		allegation: report.allegationCategory ?? "phishing",
	};
}

export type PublicCampaignVisitor = {
	/** The impersonated brand, when the analyses name one. */
	brand?: {
		name: string;
		/** As recorded by the site analysis. */
		officialUrl: string;
		/** Registrable domain of officialUrl, e.g. "google.com". */
		domain: string;
		/** The brand's real sign-in host, only when it lies on `domain`, e.g. "accounts.google.com". */
		signInHost?: string;
		/** Validated https URLs on `domain` (or its subdomains), per purpose; absent purposes are omitted. */
		links: Partial<Record<GuidancePurpose, string>>;
	};
	/** Never empty: falls back to ["email", "password"] for a sign-in page with unknown fields. */
	kinds: VisitorKind[];
};

/** `sites`: how many of the campaign's sites share what the reason names. */
export type PublicCampaign = {
	campaignId: string;
	title: string;
	summary: string;
	firstSeenAt: string;
	lastSeenAt: string;
	/** The platform every site is a subdomain of, e.g. `onrender.com`. */
	platform?: string;
	domainCount: number;
	languages: string[];
	sites: PublicCampaignSite[];
	/** What a visitor who typed something into the pages should do. */
	visitor: PublicCampaignVisitor;
	technical: {
		destinations: Array<{ endpoint: string; method: string; fields: string[]; sameSite: boolean; siteCount: number }>;
		backends: Array<{ kind: string; label: string; details: Array<[string, string]>; siteCount: number }>;
		payments: Array<{ kind: string; value: string; siteCount: number }>;
		/** The commands the pages make visitors paste, as one template shared by the sites (URLs, encoded blobs and decoy text blanked out; operators defanged). */
		deliveries: Array<{ template: string; siteCount: number }>;
		kitFiles: Array<{ sha256: string; size: number; path: string; siteCount: number }>;
		dns: Array<{ record: string; value: string; siteCount: number }>;
		abuseContacts: string[];
	};
};

const artifactUrl = (id: string) => `/api/artifacts/${id}`;

/** A site report's routes as the public page shows them, read the way the case page reads them. */
function publicSiteReports(reports: readonly SubmissionReport[]): PublicSiteReport[] {
	return rankedRoutes(reports).map(({ report, route, standing }) => {
		const next = nextStep(route, standing, report.createdAt);
		return {
			routeId: route.id.toString(),
			organisation: route.organisation,
			icon: route.icon,
			role: route.role,
			channel: route.channel,
			bucket: standing.bucket,
			label: standing.label,
			...(standing.line ? { line: standing.line } : {}),
			quoted: standing.quoted,
			...(standing.at ? { at: standing.at.toISOString() } : {}),
			...(route.outcome.sentAt ? { sentAt: new Date(route.outcome.sentAt).toISOString() } : {}),
			steps: standing.steps,
			...(next ? { next } : {}),
			...(route.confirmationId ? { ticket: route.confirmationId } : {}),
		};
	});
}

export type PublicCampaignDependencies = DossierDependencies & {
	/** The site report of a member with its routes and correspondence; tests give their own. */
	loadSiteReports?: (reportId: bigint) => Promise<SubmissionReport[]>;
};

/** The newest stored file of each name: a retried capture replaces the earlier one. */
function latestEvidence(site: DossierSite) {
	const byName = new Map<string, DossierSite["evidence"][number]>();
	for (const file of site.evidence) {
		const existing = byName.get(file.name);
		if (!existing || BigInt(file.artifactId) > BigInt(existing.artifactId)) byName.set(file.name, file);
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function count<T>(items: readonly T[], key: (item: T) => string[]): Array<[string, number]> {
	const counts = new Map<string, number>();
	for (const item of items) for (const value of new Set(key(item))) counts.set(value, (counts.get(value) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function backendDetails(evidence: Record<string, unknown>, value: string): { kind: string; label: string; details: Array<[string, string]> } {
	if (evidence.backendKind === "telegram_bot") {
		const telegram = record(evidence.telegram);
		const details: Array<[string, string | undefined]> = [["Bot ID", value.replace(/^telegram-bot:/, "")], ["Bot username", text(telegram.username) && `@${telegram.username}`], ["Chat ID", text(telegram.chatId)], ["Token", text(telegram.token)], ["Endpoint", text(evidence.endpointUrl)]];
		return { kind: "telegram_bot", label: "Telegram bot", details: details.filter((entry): entry is [string, string] => Boolean(entry[1])) };
	}
	if (evidence.backendKind === "discord_webhook") {
		const discord = record(evidence.discord);
		const details: Array<[string, string | undefined]> = [["Webhook ID", value.replace(/^discord-webhook:/, "")], ["Server ID", text(discord.guildId)], ["Channel ID", text(discord.channelId)], ["Webhook name", text(discord.name)], ["Token", text(discord.token)], ["Endpoint", text(evidence.endpointUrl)]];
		return { kind: "discord_webhook", label: "Discord webhook", details: details.filter((entry): entry is [string, string] => Boolean(entry[1])) };
	}
	const roles = operatorServerRoles(evidence);
	const delivered = record(evidence.delivered);
	const details: Array<[string, string | undefined]> = [
		["Host", value.replace(/^host:/, "")],
		["Receives", roles.includes("receives_data") ? "what visitors enter" : undefined],
		["Endpoint", text(evidence.endpointUrl)],
		["Delivers", roles.includes("delivers_malware") ? `malware visitors are made to ${delivered.via === "offered_download" ? "download" : "run"}` : undefined],
		["Malware URL", text(delivered.url)],
		["Malware SHA-256", text(delivered.sha256)],
	];
	return { kind: "server", label: "Server", details: details.filter((entry): entry is [string, string] => Boolean(entry[1])) };
}

/** The brand the sites impersonate with the stored guidance made for it, and what visitors may have typed. */
function visitorOf(dossier: Dossier, stored: VisitorGuidance | null): PublicCampaignVisitor {
	const brand = campaignBrand(dossier);
	const guidance = brand && sameBrand(stored?.brand, brand) ? stored! : undefined;
	return {
		...(brand ? { brand: { ...brand, ...(guidance?.signInHost ? { signInHost: guidance.signInHost } : {}), links: guidance?.links ?? {} } } : {}),
		kinds: campaignVisitorKinds(dossier, guidance?.kinds),
	};
}

export async function getPublicCampaign(campaignId: bigint, dependencies: PublicCampaignDependencies = {}): Promise<PublicCampaign | undefined> {
	const campaign = await CampaignRepository.getCampaign(campaignId);
	if (!campaign) return undefined;
	const dossier = await buildDossier(campaignId, dependencies);
	if (!dossier.sites.length) return undefined;
	const siteFacts = new Map((await CampaignRepository.listSiteFacts(dossier.sites.map((site) => ({ submissionId: BigInt(site.submissionId), reportId: BigInt(site.reportId) })))).map((facts) => [memberKey(facts), facts]));

	const loadSiteReports = dependencies.loadSiteReports ?? ((reportId: bigint) => getReportsByIds([reportId]));
	const siteReports = new Map(await Promise.all(dossier.sites.map(async (site) => [site.key, await loadSiteReports(BigInt(site.reportId))] as const)));

	const sites: PublicCampaignSite[] = dossier.sites.map((site) => {
		const facts = siteFacts.get(site.key);
		const evidence = latestEvidence(site);
		const pages = evidence.flatMap((file) => {
			const page = screenshotPage(file.name);
			if (!page || !site.pages.some((shown) => comparePages(shown, page) === 0)) return [];
			const stamped = evidence.find((other) => other.name === file.name.replace(/\.png$/, "-stamped.png"));
			return [{ page, screenshot: file, stamped }];
		}).sort((a, b) => comparePages(a.page, b.page));
		const judged = pages.find(({ page }) => site.page && comparePages(page, site.page) === 0);
		const screenshot = judged && (judged.stamped ?? judged.screenshot);
		// Numbered by the order the site's pages were shown in, across the routes the case walked.
		const steps = pages.map((page, index) => ({ step: index + 1, screenshotUrl: artifactUrl(page.screenshot.artifactId), ...(page.stamped ? { stampedUrl: artifactUrl(page.stamped.artifactId) } : {}) }));
		const loaded = siteReports.get(site.key) ?? [];
		const reports = publicSiteReports(loaded);
		const moved = publicSiteMove(loaded);
		return {
			key: site.key,
			submissionId: site.submissionId,
			url: site.url,
			host: site.host,
			firstSeenAt: site.firstSeenAt,
			...(facts?.language ? { language: facts.language } : {}),
			...(facts?.thumbnailArtifactId ? { thumbnailUrl: artifactUrl(facts.thumbnailArtifactId.toString()) } : {}),
			...(screenshot ? { screenshotUrl: artifactUrl(screenshot.artifactId) } : {}),
			blankCapture: facts?.blankCapture ?? false,
			steps,
			asks: [...new Set(site.dataDestinations.flatMap((destination) => destination.fields))].map((field) => CANARY_FIELD_LABEL[field as CanaryField] ?? field),
			...(site.verdict ? { verdict: {
				finding: site.verdict.finding,
				...(site.verdict.basis ? { basis: site.verdict.basis } : {}),
				...(site.verdict.quote ? { quote: site.verdict.quote } : {}),
				...(site.verdict.impersonates ? { impersonates: site.verdict.impersonates.name } : {}),
				fields: site.verdict.fields,
			} } : {}),
			sent: site.dataDestinations.map((destination) => ({ ...destination, fields: destination.fields.map((field) => CANARY_FIELD_LABEL[field as CanaryField] ?? field) })),
			reports,
			evidence: evidence.map((file) => ({ name: file.name, size: file.size, sha256: file.sha256, url: artifactUrl(file.artifactId) })),
			takedown: siteTakedown(reports),
			...(moved ? { moved } : {}),
		};
	});

	const domains = new Set(sites.map((site) => getDomain(site.host, { allowPrivateDomains: false }) ?? site.host));
	const platform = domains.size === 1 && sites.every((site) => site.host !== [...domains][0]) ? [...domains][0] : undefined;

	const shared = dossier.indicators.filter((indicator) => indicator.links);
	const destinations = new Map<string, PublicCampaign["technical"]["destinations"][number]>();
	for (const site of dossier.sites) {
		for (const destination of site.dataDestinations) {
			let endpoint = destination.url;
			if (destination.sameSite) {
				try {
					endpoint = `https://<site>${new URL(destination.url).pathname}`;
				} catch {
					// Keep the redacted URL as it is.
				}
			}
			const key = `${destination.method} ${endpoint}`;
			const entry = destinations.get(key) ?? { endpoint, method: destination.method, fields: [], sameSite: destination.sameSite, siteCount: 0 };
			entry.fields = [...new Set([...entry.fields, ...destination.fields.map((field) => CANARY_FIELD_LABEL[field as CanaryField] ?? field)])];
			entry.siteCount += 1;
			destinations.set(key, entry);
		}
	}
	const dnsRecords: PublicCampaign["technical"]["dns"] = [];
	for (const [record, key] of [["CNAME", "cname"], ["A", "a"], ["AAAA", "aaaa"], ["NS", "ns"]] as const) {
		for (const [value, siteCount] of count(dossier.sites, (site) => site.dns[key])) dnsRecords.push({ record, value, siteCount });
	}
	const description = campaign.title && campaign.summary
		? { title: campaign.title, summary: campaign.summary }
		: fallbackDescription(factsFromDossier(dossier, [...siteFacts.values()].map((facts) => facts.language)));

	return withoutBackendSecrets({
		campaignId: dossier.campaignId,
		...description,
		firstSeenAt: dossier.firstSeenAt,
		lastSeenAt: dossier.lastSeenAt,
		...(platform ? { platform } : {}),
		domainCount: domains.size,
		languages: [...new Set(sites.map((site) => site.language).filter((language): language is string => Boolean(language)))],
		sites,
		visitor: visitorOf(dossier, campaign.visitorGuidance),
		technical: {
			destinations: [...destinations.values()],
			backends: shared.filter((indicator) => indicator.kind === "operator_server").map((indicator) => ({
				...backendDetails(indicator.evidence, indicator.value),
				siteCount: indicator.sites.length,
			})),
			payments: shared.filter((indicator) => indicator.kind === "payment_receiver").map((indicator) => ({
				kind: String(indicator.evidence.receiverKind ?? "account"),
				value: String(indicator.evidence.receiver ?? indicator.value.replace(/^[a-z]+:/, "")),
				siteCount: indicator.sites.length,
			})),
			deliveries: shared.filter((indicator) => indicator.kind === "delivery_command").map((indicator) => ({
				template: defangCommand(String(indicator.evidence.template ?? "")),
				siteCount: indicator.sites.length,
			})).sort((a, b) => b.siteCount - a.siteCount),
			kitFiles: dossier.indicators.filter((indicator) => indicator.kind === "kit_fingerprint" && indicator.links).map((indicator) => {
				let path = String(indicator.evidence.url ?? "");
				try {
					path = indicator.evidence.fileKind === "page_document" ? "the page body (own address masked)"
						: indicator.evidence.fileKind === "page_structure" ? "the page's template (its HTML elements in order)"
						: new URL(path).pathname;
				} catch {
					// Keep what was stored.
				}
				return { sha256: indicator.value, size: Number(indicator.evidence.size ?? 0), path, siteCount: indicator.sites.length };
			}).sort((a, b) => b.siteCount - a.siteCount || b.size - a.size),
			dns: dnsRecords,
			abuseContacts: [...new Set(dossier.sites.flatMap((site) => site.reports.map((report) => report.contact).filter((contact): contact is string => Boolean(contact))))].sort(),
		},
	});
}
