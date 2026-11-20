import { getDomain } from "tldts";

import { defangCommand } from "../malware/defang";
import { buildDossier, type Dossier, type DossierDependencies, type DossierSite } from "../referral/dossier";
import { record, text } from "../util/values";
import { CANARY_FIELD_LABEL, type CanaryField } from "../website/types";
import { campaignBrand, sameBrand, type GuidancePurpose, type VisitorGuidance } from "./guidance";
import { campaignVisitorKinds, type VisitorKind } from "./kinds";
import { factsFromDossier } from "./link";
import { CampaignRepository } from "./repository";
import { operatorServerRoles, type OperatorServerRole } from "./schema";
import { fallbackDescription } from "./summary";

export type { GuidancePurpose } from "./guidance";
export type { VisitorKind } from "./kinds";

/**
 * Everything the public page of a campaign shows, derived from stored data
 * for every campaign alike: a heading written from the sites' analyses, the
 * sites with previews and takedown history, why they belong together, and
 * the full technical record: everything the authorities get, including the
 * bot tokens and accounts the operators published on their own pages.
 */
export type PublicReportState = "accepted" | "awaiting" | "confirmed" | "rejected" | "bounced" | "failed" | "pending";

export type PublicCampaignSite = {
	submissionId: string;
	url: string;
	host: string;
	firstSeenAt: string;
	language?: string;
	thumbnailUrl?: string;
	screenshotUrl?: string;
	/** The analyzed page's screenshot is one flat colour, useless as a picture. */
	blankCapture: boolean;
	asks: string[];
	/** Every page the visit captured, in the order shown: the landing page, the forms, the pages after them. */
	steps: Array<{ step: number; screenshotUrl: string; stampedUrl?: string }>;
	/** Why the page was judged phishing: the page's own words and the fields it collects with. */
	verdict?: { finding: string; basis?: string; quote?: string; impersonates?: string; fields: string[] };
	/** Where the synthetic values our visit entered went. */
	sent: Array<{ url: string; method: string; fields: string[]; sameSite: boolean }>;
	reports: Array<{ provider: string; channel: string; state: PublicReportState; reportedAt?: string; ticket?: string }>;
	evidence: Array<{ name: string; size: number; sha256: string; url: string }>;
	/** The furthest any provider got: confirmed, reported, or not reported yet. */
	takedown: "confirmed" | "reported" | "problem" | "none";
};

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

type PublicCampaignReason = { kind: "same_code" | "same_page" | "same_structure" | "same_backend" | "same_delivery" | "same_payment_account" | "same_pattern"; title: string; text: string };

export type PublicCampaign = {
	campaignId: string;
	title: string;
	summary: string;
	firstSeenAt: string;
	lastSeenAt: string;
	durationMinutes: number;
	/** The usual gap between two new sites, when there are at least three. */
	typicalIntervalMinutes?: number;
	/** The platform every site is a subdomain of, e.g. `onrender.com`. */
	platform?: string;
	domainCount: number;
	reportedCount: number;
	confirmedCount: number;
	languages: string[];
	sites: PublicCampaignSite[];
	reasons: PublicCampaignReason[];
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

const STATE: Record<string, PublicReportState> = {
	submitted: "accepted",
	awaiting_provider_reply: "awaiting",
	acknowledged: "confirmed",
	provider_rejected: "rejected",
	delivery_failed: "bounced",
	failed: "failed",
	unknown_external_state: "failed",
};

const artifactUrl = (id: string) => `/api/artifacts/${id}`;

function minutes(from: string, to: string): number {
	return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
}

function median(values: number[]): number | undefined {
	if (!values.length) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

function duration(value: number): string {
	if (value < 120) return `${value} minutes`;
	if (value < 72 * 60) return `${Math.round(value / 60)} hours`;
	return `${Math.round(value / 1_440)} days`;
}

/** The newest stored file of each name: a retried capture replaces the earlier one. */
function latestEvidence(site: DossierSite) {
	const byName = new Map<string, DossierSite["evidence"][number]>();
	for (const file of site.evidence) {
		const existing = byName.get(file.name);
		if (!existing || BigInt(file.artifactId) > BigInt(existing.artifactId)) byName.set(file.name, file);
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function takedownOf(reports: PublicCampaignSite["reports"]): PublicCampaignSite["takedown"] {
	if (reports.some((report) => report.state === "confirmed")) return "confirmed";
	if (reports.some((report) => report.state === "accepted" || report.state === "awaiting")) return "reported";
	if (reports.length) return "problem";
	return "none";
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

/** Why the sites are one operator's, in plain words, from the indicators that hold. */
function reasons(dossier: Dossier, stats: { platform?: string; durationMinutes: number; typicalIntervalMinutes?: number }): PublicCampaignReason[] {
	const shared = dossier.indicators.filter((indicator) => indicator.links && indicator.sites.length > 1);
	const all = dossier.sites.length;
	const result: PublicCampaignReason[] = [];
	const fingerprints = (fileKinds: readonly string[], include: boolean) => shared.filter((indicator) => indicator.kind === "kit_fingerprint" && fileKinds.includes(String(indicator.evidence.fileKind)) === include);
	const reach = (indicators: typeof shared) => Math.max(0, ...indicators.map((indicator) => indicator.sites.length));
	/** "Every page serves" or "3 of the 5 pages serve". */
	const subject = (indicators: typeof shared, singular: string, plural: string) => reach(indicators) === all ? `Every page ${singular}` : `${reach(indicators)} of the ${all} pages ${plural}`;
	const page = fingerprints(["page_document"], true);
	if (page.length) {
		result.push({ kind: "same_page", title: "Same page", text: `${subject(page, "serves", "serve")} the same page body, byte for byte apart from its own address. A copied design would not match this exactly.` });
	}
	// A template only adds to an identical body where it reaches pages whose words differ.
	const structure = fingerprints(["page_structure"], true);
	if (structure.length && reach(structure) > reach(page)) {
		const widest = structure.reduce((best, indicator) => (indicator.sites.length > best.sites.length ? indicator : best));
		result.push({ kind: "same_structure", title: "Same template", text: `${subject(structure, "is", "are")} built from the same template: the same ${Number(widest.evidence.tags)} HTML elements in the same order; only the words differ.` });
	}
	const kit = fingerprints(["page_document", "page_structure"], false);
	if (kit.length) {
		result.push({ kind: "same_code", title: "Same code", text: `${subject(kit, "runs", "run")} the same program ${kit.length === 1 ? "file" : `files (${kit.length})`}, byte for byte. A copied design would not match this exactly, and none of these files is a public library.` });
	}
	const servers = shared.filter((indicator) => indicator.kind === "operator_server");
	if (servers.length) {
		const doing = (role: OperatorServerRole) => servers.filter((indicator) => operatorServerRoles(indicator.evidence).includes(role));
		const names = (indicators: typeof servers) => [...new Set(indicators.map((indicator) => backendDetails(indicator.evidence, indicator.value).label.toLowerCase()))].join(" and ");
		const hosts = (indicators: typeof servers) => indicators.map((indicator) => indicator.value.replace(/^host:/, "")).join(", ");
		const uses = [
			doing("receives_data").length && `what visitors enter goes to the same ${names(doing("receives_data"))}`,
			doing("delivers_malware").length && `the malware visitors are made to run or download comes from the same server (${hosts(doing("delivers_malware"))})`,
		].filter(Boolean).join(", and ");
		result.push({ kind: "same_backend", title: "Same server", text: `${subject(servers, "uses", "use")} a server only its operator controls: ${uses}.` });
	}
	const deliveries = shared.filter((indicator) => indicator.kind === "delivery_command");
	if (deliveries.length) {
		result.push({ kind: "same_delivery", title: "Same command", text: `${subject(deliveries, "makes", "make")} visitors paste the same command: the same steps, flags and interpreter, whichever server and decoy app name it names.` });
	}
	if (shared.some((indicator) => indicator.kind === "payment_receiver")) {
		result.push({ kind: "same_payment_account", title: "Same payment account", text: "The pages ask visitors to pay into the same account." });
	}
	if (all >= 3 && stats.typicalIntervalMinutes !== undefined && stats.durationMinutes <= 7 * 1_440) {
		result.push({ kind: "same_pattern", title: "Same pattern", text: `${all} pages${stats.platform ? ` on ${stats.platform}` : ""} within ${duration(stats.durationMinutes)}, a new one about every ${duration(stats.typicalIntervalMinutes)}.` });
	}
	return result;
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

export async function getPublicCampaign(campaignId: bigint, dependencies: DossierDependencies = {}): Promise<PublicCampaign | undefined> {
	const campaign = await CampaignRepository.getCampaign(campaignId);
	if (!campaign) return undefined;
	const dossier = await buildDossier(campaignId, dependencies);
	if (!dossier.sites.length) return undefined;
	const siteFacts = new Map((await CampaignRepository.listSiteFacts(dossier.sites.map((site) => BigInt(site.submissionId)))).map((facts) => [facts.submissionId.toString(), facts]));

	const sites: PublicCampaignSite[] = dossier.sites.map((site) => {
		const facts = siteFacts.get(site.submissionId);
		const evidence = latestEvidence(site);
		const screenshot = evidence.find((file) => file.name === "website-stamped.png") ?? evidence.find((file) => file.name === "website.png");
		const steps = evidence.flatMap((file) => {
			const match = file.name.match(/^website(?:-step(\d+))?\.png$/);
			if (!match) return [];
			const step = match[1] ? Number(match[1]) : 1;
			const stamped = evidence.find((other) => other.name === file.name.replace(/\.png$/, "-stamped.png"));
			return [{ step, screenshotUrl: artifactUrl(file.artifactId), ...(stamped ? { stampedUrl: artifactUrl(stamped.artifactId) } : {}) }];
		}).sort((a, b) => a.step - b.step);
		const reports = site.reports.map((report) => ({
			provider: report.provider,
			channel: report.channel === "email" ? report.contact ?? "email" : report.channel === "form" ? "web form / API" : "none",
			state: STATE[report.status] ?? "pending",
			...(report.reportedAt ? { reportedAt: report.reportedAt } : {}),
			...(report.confirmationId ? { ticket: report.confirmationId } : {}),
		}));
		return {
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
			takedown: takedownOf(reports),
		};
	});

	const times = [...new Set(sites.map((site) => site.firstSeenAt))].sort();
	const gaps = times.slice(1).map((time, index) => minutes(times[index]!, time)).filter((gap) => gap > 0);
	const durationMinutes = minutes(dossier.firstSeenAt, dossier.lastSeenAt);
	const typicalIntervalMinutes = sites.length >= 3 ? median(gaps) : undefined;
	const domains = new Set(sites.map((site) => getDomain(site.host, { allowPrivateDomains: false }) ?? site.host));
	const platform = domains.size === 1 && sites.every((site) => site.host !== [...domains][0]) ? [...domains][0] : undefined;
	const stats = { platform, durationMinutes, ...(typicalIntervalMinutes !== undefined ? { typicalIntervalMinutes } : {}) };

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

	return {
		campaignId: dossier.campaignId,
		...description,
		firstSeenAt: dossier.firstSeenAt,
		lastSeenAt: dossier.lastSeenAt,
		...stats,
		domainCount: domains.size,
		reportedCount: sites.filter((site) => site.takedown === "confirmed" || site.takedown === "reported").length,
		confirmedCount: sites.filter((site) => site.takedown === "confirmed").length,
		languages: [...new Set(sites.map((site) => site.language).filter((language): language is string => Boolean(language)))],
		sites,
		reasons: reasons(dossier, stats),
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
	};
}
