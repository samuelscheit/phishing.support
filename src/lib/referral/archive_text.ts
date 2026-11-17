import { publicCampaignUrl } from "../campaign/urls";
import { CANARY_FIELD_LABEL, type CanaryField } from "../website_types";
import type { Dossier, DossierIndicator, DossierSite } from "./dossier";
import { GENERIC_LEAD_EN } from "./provider_leads";

/**
 * The evidence archive's own texts, in English for every reader: the
 * campaign overview, one analysis per site that says why it is phishing and
 * what was entered where, and the two tables. The complaint mails to German
 * authorities carry their own German text (drafts.ts).
 */

function utc(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const fieldLabel = (field: string) => CANARY_FIELD_LABEL[field as CanaryField] ?? field;

/** One indicator as a sentence an investigator can act on. */
export function describeIndicatorEnglish(indicator: DossierIndicator): string {
	const evidence = indicator.evidence;
	const reach = `(${plural(indicator.sites.length, "site", "sites")})`;
	if (indicator.kind === "exfiltration_backend") {
		const observed = text(evidence.observedAt) ? `, observed ${utc(String(evidence.observedAt))}` : "";
		if (evidence.backendKind === "telegram_bot") {
			const telegram = record(evidence.telegram);
			const username = text(telegram.username) ? ` (@${telegram.username})` : "";
			const chat = text(telegram.chatId) ? `, chat ID ${telegram.chatId}` : "";
			const token = text(telegram.token) ? `; bot token ${telegram.token}` : "";
			return `Telegram bot ${indicator.value.replace(/^telegram-bot:/, "")}${username} receives what visitors enter ${reach}${chat}${token}${observed}.`;
		}
		if (evidence.backendKind === "discord_webhook") {
			const discord = record(evidence.discord);
			const ids = [text(discord.guildId) && `server ID ${discord.guildId}`, text(discord.channelId) && `channel ID ${discord.channelId}`, text(discord.token) && `token ${discord.token}`].filter(Boolean).join(", ");
			return `Discord webhook ${indicator.value.replace(/^discord-webhook:/, "")}${ids ? ` (${ids})` : ""} receives what visitors enter ${reach}${observed}.`;
		}
		return `Collector server ${indicator.value.replace(/^collector-host:/, "")} receives what visitors enter ${reach}${text(evidence.endpointUrl) ? ` via ${evidence.method ?? "POST"} ${evidence.endpointUrl}` : ""}${observed}.`;
	}
	if (indicator.kind === "payment_receiver") {
		return `Payment account ${text(evidence.receiver) ?? indicator.value} (${text(evidence.receiverKind) ?? "account"}) is named to visitors ${reach}.`;
	}
	if (indicator.kind === "kit_fingerprint") {
		const library = text(evidence.library) ? `; a published library file (${evidence.library}), so it links nothing` : "";
		return `Identical kit file (${evidence.fileKind === "hidden_frame" ? "hidden frame document" : "script"}, ${evidence.size ?? "?"} bytes, SHA-256 ${indicator.value}) ${reach}${library}.`;
	}
	const asns = Array.isArray(evidence.asns) ? evidence.asns.map(record).map((asn) => `AS${asn.asn}${text(asn.name) ? ` ${asn.name}` : ""}`).join(", ") : "";
	return `Server IP ${indicator.value}${text(evidence.network) ? `, network ${evidence.network}` : ""}${asns ? `, ${asns}` : ""}${text(evidence.country) ? `, country ${evidence.country}` : ""} ${reach}.`;
}

const STATE: Readonly<Record<string, string>> = {
	submitted: "accepted",
	acknowledged: "confirmed by the provider",
	awaiting_provider_reply: "sent, no answer yet",
	provider_rejected: "rejected by the provider",
	delivery_failed: "not delivered",
	failed: "failed",
	no_route: "no reporting route",
	needs_human: "under manual review",
};

function reportLine(report: DossierSite["reports"][number]): string {
	const state = STATE[report.status] ?? report.status.replaceAll("_", " ");
	return `${report.provider}${report.contact ? ` <${report.contact}>` : ""}: ${report.reportedAt ? `reported ${utc(report.reportedAt)}, ` : ""}${state}${report.confirmationId ? `, ticket ${report.confirmationId}` : ""}`;
}

/**
 * Why one site is phishing and what our visit did there: the page's own
 * words, the fields it asks for, every action of the visit and every request
 * that carried a synthetic value. Visits from 17 Nov 2026 on also keep the
 * full, timestamped record next to this file.
 */
export function siteAnalysisText(site: DossierSite): string {
	const verdict = site.verdict;
	const hasVisitRecord = site.evidence.some((file) => file.name === "visit-record.json");
	const lines = [
		`Analysis of ${site.url}`,
		`Case ${site.submissionId}, first seen ${utc(site.firstSeenAt)}${site.registeredAt ? `; domain registered ${utc(site.registeredAt)}` : ""}${site.registrar ? ` at ${site.registrar}` : ""}.`,
		"",
		"Why it is phishing",
	];
	if (verdict) {
		const basis = verdict.basis === "credential_theft" ? "it collects sign-in credentials" : verdict.basis === "payment_fraud" ? "it takes payment or card data" : verdict.finding;
		lines.push(`  Finding: ${verdict.finding}${verdict.basis ? ` (${basis})` : ""}, on ${verdict.pageUrl ?? site.url}.`);
		if (verdict.impersonates) lines.push(`  It imitates ${verdict.impersonates.name}, whose official site is ${verdict.impersonates.officialUrl}.`);
		if (verdict.quote) lines.push(`  The page's own words: "${verdict.quote}"`);
		if (verdict.fields.length) lines.push(`  Fields it asks for: ${verdict.fields.join(", ")}.`);
	} else {
		lines.push("  No stored classification; see the report text below.");
	}
	if (site.reportText) lines.push("", "What we reported to the providers", ...site.reportText.split(/\r?\n/).map((line) => `  ${line}`));
	lines.push("", "What our visit entered and where it went");
	lines.push("  Our browser walked the site as a victim would, entering only synthetic values generated for that visit; they belong to no person.");
	if (site.dataDestinations.length) {
		for (const destination of site.dataDestinations) {
			lines.push(`  ${destination.method} ${destination.url} received the synthetic ${destination.fields.map(fieldLabel).join(", ")}${destination.sameSite ? " (the site's own server)" : " (a server outside the site)"}.`);
		}
	} else {
		lines.push("  No request carried a synthetic value while the visit was recorded.");
	}
	if (site.visit) {
		lines.push("", `Visit steps (${site.visit.outcome}${site.visit.failure ? `: ${site.visit.failure}` : ""})`);
		for (const [index, action] of site.visit.actions.entries()) lines.push(`  ${index + 1}. ${action.kind}: ${action.text}`);
	}
	lines.push("", hasVisitRecord
		? "The full visit record (visit-record.json: every value typed and every request with its body and the server's answer; visit-protocol.txt: the same as a dated chronology) is in this folder, covered by visit-manifest.json and its RFC 3161 timestamp."
		: "This visit predates the full visit record (kept for visits from 17 Nov 2026 on): what is above is the summary the case kept at the time.");
	lines.push("", "Takedown reports", ...(site.reports.length ? site.reports.map((report) => `  ${reportLine(report)}`) : ["  None yet."]));
	return `${lines.join("\n")}\n`;
}

function csvCell(value: unknown): string {
	const cell = value === undefined || value === null ? "" : String(value);
	return /[",\n\r]/.test(cell) ? `"${cell.replaceAll("\"", "\"\"")}"` : cell;
}

function csv(rows: unknown[][]): string {
	return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function sitesCsv(sites: readonly DossierSite[]): string {
	return csv([
		["No", "URL", "Host", "First seen (UTC)", "Registered", "Registrar", "Finding", "Quote", "Data sent", "Takedown reports", "Linking indicators", "Evidence files (SHA-256)", "Case"],
		...sites.map((site, index) => [
			index + 1,
			site.url,
			site.host,
			site.firstSeenAt,
			site.registeredAt ?? "",
			site.registrar ?? "",
			site.verdict ? `${site.verdict.finding}${site.verdict.basis ? ` (${site.verdict.basis})` : ""}` : "",
			site.verdict?.quote ?? "",
			site.dataDestinations.map((destination) => `${destination.method} ${destination.url}: ${destination.fields.join("+")}`).join(" | "),
			site.reports.map(reportLine).join(" | "),
			site.indicators.filter((indicator) => indicator.links).map((indicator) => `${indicator.kind}:${indicator.value}`).join(" | "),
			site.evidence.map((file) => `${file.name} ${file.sha256}`).join(" | "),
			site.submissionId,
		]),
	]);
}

export function indicatorsCsv(indicators: readonly DossierIndicator[]): string {
	return csv([
		["Kind", "Value", "Links sites", "Description", "Sites"],
		...indicators.map((indicator) => [indicator.kind, indicator.value, indicator.links ? "yes" : "no", describeIndicatorEnglish(indicator), indicator.sites.join(" | ")]),
	]);
}

/** The campaign overview at the top of the archive. */
export function dossierText(dossier: Dossier): string {
	const lines = [
		`Phishing campaign ${dossier.campaignId} (phishing.support), dossier of ${utc(dossier.generatedAt)}`,
		`Public page: ${publicCampaignUrl(dossier.campaignId)}`,
		"",
		`${plural(dossier.sites.length, "site", "sites")}, first seen between ${utc(dossier.firstSeenAt)} and ${utc(dossier.lastSeenAt)}.`,
		...(dossier.impersonates.length ? [`Imitates: ${dossier.impersonates.join(", ")}.`] : []),
		...(dossier.requestedFields.length ? [`Asks visitors for: ${dossier.requestedFields.map(fieldLabel).join(", ")}.`] : []),
		"",
		"What ties the sites together",
		...dossier.indicators.filter((indicator) => indicator.links || indicator.kind === "origin_ip").map((indicator) => `  - ${describeIndicatorEnglish(indicator)}`),
		"",
		"Sites (each folder under evidence/ holds the site's analysis.txt and its evidence files)",
		...dossier.sites.map((site, index) => `  ${index + 1}. ${site.url}, first seen ${utc(site.firstSeenAt)}${site.verdict?.quote ? `: "${site.verdict.quote}"` : ""}`),
		"",
		"Where investigators find the providers' records",
		...[...new Set(dossier.providers.map((provider) => `  - ${provider.lead?.providerEn ?? provider.name}: ${provider.lead?.leadEn ?? GENERIC_LEAD_EN}${provider.contacts.length ? ` (abuse contact ${provider.contacts.join(", ")})` : ""}`))],
		"",
		"Evidence per capture: the MHTML archive, the screenshot, the screenshot with address and time stamped in, a manifest naming every file by SHA-256, and an RFC 3161 timestamp token over the manifest from an independent authority (verify with: openssl ts -verify -data <manifest> -in <token> -CAfile <authority chain>). Hashes are also in sites.csv.",
	];
	return `${lines.join("\n")}\n`;
}
