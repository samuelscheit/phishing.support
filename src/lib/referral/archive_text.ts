import { publicCampaignUrl } from "../campaign/urls";
import { CANARY_FIELD_LABEL, type CanaryField } from "../website_types";
import sanitizeFilename from "sanitize-filename";

import type { Dossier, DossierIndicator, DossierMail, DossierSite } from "./dossier";
import { plural, record, text, utc } from "./format";
import { infrastructureLines } from "./infrastructure";

/**
 * The evidence archive's own texts, in English for every reader: the
 * campaign overview, one analysis per site that says why it is phishing and
 * what was entered where, and the two tables. The complaint mails to German
 * authorities carry their own German text (drafts.ts).
 */

export const fieldLabel = (field: string) => CANARY_FIELD_LABEL[field as CanaryField] ?? field;

/** A mail's file in the site's correspondence folder: position, time, direction and provider, so the folder sorts chronologically. */
export function correspondenceFileName(mail: DossierMail, position: number): string {
	const time = mail.occurredAt.slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
	const provider = sanitizeFilename(mail.provider).replace(/\s+/g, "-").slice(0, 40) || "provider";
	return `${String(position + 1).padStart(3, "0")}-${time}-${mail.direction === "outbound" ? "sent" : "received"}-${provider}.${mail.raw ? "eml" : "txt"}`;
}

/** The site's correspondence in order, with the SHA-256 of each original. */
export function correspondenceIndexText(site: DossierSite): string {
	const lines = [
		`Correspondence with providers about ${site.url}, oldest first. Each .eml file is the message exactly as it was sent or received; a .txt file holds only the text where no original was stored.`,
		"",
		...site.correspondence.map((mail, position) => {
			const direction = mail.direction === "outbound" ? `sent to ${mail.to.join(", ") || mail.provider}` : `received from ${mail.from ?? mail.provider}`;
			const hash = mail.raw ? `, SHA-256 ${mail.raw.sha256}` : "";
			return `${position + 1}. ${utc(mail.occurredAt)}, ${direction} (${mail.provider}): ${mail.subject ?? "(no subject)"}\n   ${correspondenceFileName(mail, position)}${hash}`;
		}),
	];
	return `${lines.join("\n")}\n`;
}

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
	if (indicator.kind === "payload_host") {
		return `Malware server ${indicator.value.replace(/^payload-host:/, "")} delivers what visitors are made to ${evidence.via === "offered_download" ? "download" : "run"} ${reach}${text(evidence.url) ? `, e.g. ${evidence.url}` : ""}${text(evidence.sha256) ? ` (SHA-256 ${evidence.sha256})` : ""}.`;
	}
	if (indicator.kind === "kit_fingerprint") {
		const library = text(evidence.library) ? `; a published library file (${evidence.library}), so it links nothing` : "";
		if (evidence.fileKind === "page_structure") return `Identical page template (the same ${evidence.tags ?? "?"} HTML elements in the same order, text and attributes left out; SHA-256 ${indicator.value}) ${reach}.`;
		if (evidence.fileKind === "page_document") return `Identical page body (HTML, ${evidence.size ?? "?"} bytes; the page's own address masked; SHA-256 ${indicator.value}) ${reach}.`;
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
	if (site.correspondence.length) lines.push(`  The ${plural(site.correspondence.length, "mail", "mails")} with the providers are in correspondence/ (index.txt lists them).`);
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
		"Where investigators find the providers' records, by state",
		...infrastructureLines(dossier.infrastructure, "en").map((line) => `  ${line}`),
		"",
		"Evidence per capture: the MHTML archive, the screenshot, the screenshot with address and time stamped in, a manifest naming every file by SHA-256, and an RFC 3161 timestamp token over the manifest from an independent authority (verify with: openssl ts -verify -data <manifest> -in <token> -CAfile <authority chain>). Hashes are also in sites.csv.",
	];
	return `${lines.join("\n")}\n`;
}
