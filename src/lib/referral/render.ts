import type { Dossier, DossierIndicator, DossierProvider, DossierSite } from "./dossier";
import { GENERIC_LEAD } from "./provider_leads";
import { publicCampaignUrl } from "../campaign/urls";

const BERLIN = new Intl.DateTimeFormat("de-DE", {
	timeZone: "Europe/Berlin",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
});
const BERLIN_DAY = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" });

/** A timestamp as a German authority reads it: local time in Germany. */
export function germanDateTime(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : `${BERLIN.format(date)} Uhr`;
}

export function germanDate(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : BERLIN_DAY.format(date);
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const RECEIVER_LABEL: Readonly<Record<string, string>> = { iban: "IBAN", bitcoin: "Bitcoin-Adresse", tron: "TRON-Adresse", ethereum: "Ethereum-Adresse" };

/** One indicator as a sentence an investigator can act on. */
export function describeIndicator(indicator: DossierIndicator): string {
	const evidence = indicator.evidence;
	const reach = `(${plural(indicator.sites.length, "Seite", "Seiten")})`;
	if (indicator.kind === "exfiltration_backend") {
		const observed = text(evidence.observedAt) ? `, beobachtet am ${germanDateTime(evidence.observedAt as string)}` : "";
		if (evidence.backendKind === "telegram_bot") {
			const telegram = record(evidence.telegram);
			const botId = indicator.value.replace(/^telegram-bot:/, "");
			const username = text(telegram.username) ? ` (@${telegram.username})` : "";
			const chat = text(telegram.chatId) ? `, Ziel-Chat-ID ${telegram.chatId}` : "";
			const token = text(telegram.token) ? `; Bot-Token ${telegram.token}` : "";
			return `Telegram-Bot ${botId}${username} empfängt die Eingaben der Besucher ${reach}${chat}${token}${observed}.`;
		}
		if (evidence.backendKind === "discord_webhook") {
			const discord = record(evidence.discord);
			const ids = [text(discord.guildId) ? `Server-ID ${discord.guildId}` : undefined, text(discord.channelId) ? `Kanal-ID ${discord.channelId}` : undefined].filter(Boolean).join(", ");
			return `Discord-Webhook ${indicator.value.replace(/^discord-webhook:/, "")}${ids ? ` (${ids})` : ""} empfängt die Eingaben der Besucher ${reach}${observed}.`;
		}
		return `Sammelserver ${indicator.value.replace(/^collector-host:/, "")} empfängt die Eingaben der Besucher ${reach}${text(evidence.endpointUrl) ? ` über ${evidence.method ?? "POST"} ${evidence.endpointUrl}` : ""}${observed}.`;
	}
	if (indicator.kind === "payment_receiver") {
		const kind = text(evidence.receiverKind) ?? "";
		return `${RECEIVER_LABEL[kind] ?? "Zahlungsempfänger"} ${text(evidence.receiver) ?? indicator.value} wird Besuchern als Zahlungsziel genannt ${reach}.`;
	}
	if (indicator.kind === "kit_fingerprint") {
		const file = evidence.fileKind === "hidden_frame" ? "verborgenes Frame-Dokument" : "Skript";
		return `Identische Kit-Datei (${file}, ${evidence.size ?? "?"} Byte, SHA-256 ${indicator.value}) ${reach}.`;
	}
	const asns = Array.isArray(evidence.asns) ? evidence.asns.map((asn) => record(asn)).map((asn) => `AS${asn.asn}${text(asn.name) ? ` ${asn.name}` : ""}`).join(", ") : "";
	return `Server-IP ${indicator.value}${text(evidence.network) ? `, Netz ${evidence.network}` : ""}${asns ? `, ${asns}` : ""}${text(evidence.country) ? `, Land ${evidence.country}` : ""} ${reach}.`;
}

/** The indicators that tie the sites to one operator, then the ones that only describe them. */
export function indicatorLines(indicators: readonly DossierIndicator[]): string[] {
	return indicators
		.filter((indicator) => indicator.links || indicator.kind === "origin_ip")
		.map((indicator) => `- ${describeIndicator(indicator)}`);
}

/** What became of a takedown report, after "gemeldet am …". */
const STATUS_LABEL: Readonly<Record<string, string>> = {
	submitted: "eingegangen",
	acknowledged: "vom Anbieter bestätigt",
	awaiting_provider_reply: "Antwort ausstehend",
	provider_rejected: "vom Anbieter abgelehnt",
	delivery_failed: "Zustellung fehlgeschlagen",
	failed: "fehlgeschlagen",
	no_route: "kein Meldeweg",
	needs_human: "in manueller Prüfung",
};

function reportLine(report: DossierSite["reports"][number]): string {
	const outcome = STATUS_LABEL[report.status] ?? report.status.replaceAll("_", " ");
	const ticket = report.confirmationId ? `, Ticket ${report.confirmationId}` : "";
	return report.reportedAt
		? `${report.provider}: gemeldet am ${germanDate(report.reportedAt)}, ${outcome}${ticket}`
		: `${report.provider}: ${outcome}${ticket}`;
}

export function siteLine(site: DossierSite, index: number): string {
	const registered = site.registeredAt ? `, registriert ${germanDate(site.registeredAt)}` : "";
	const registrar = site.registrar ? `, Registrar ${site.registrar}` : "";
	const reports = site.reports.length ? site.reports.map(reportLine).join("; ") : "noch keine Meldung";
	return `${index + 1}. ${site.url}\n   erfasst ${germanDateTime(site.firstSeenAt)}${registered}${registrar}\n   Sperrmeldungen: ${reports}`;
}

export function providerLines(providers: readonly DossierProvider[]): string[] {
	const lines = providers.map((provider) => {
		const lead = provider.lead ? `${provider.lead.provider}: ${provider.lead.lead}` : `${provider.name}: ${GENERIC_LEAD}`;
		return `- ${lead} (${plural(provider.siteCount, "Seite", "Seiten")}${provider.contacts.length ? `; Abuse-Kontakt ${provider.contacts.join(", ")}` : ""})`;
	});
	return [...new Set(lines)];
}

function csvCell(value: unknown): string {
	const cell = value === undefined || value === null ? "" : String(value);
	return /[";\n\r]/.test(cell) ? `"${cell.replaceAll("\"", "\"\"")}"` : cell;
}

function csv(rows: unknown[][]): string {
	// Semicolons and a BOM make the file open as columns in German Excel.
	return `\uFEFF${rows.map((row) => row.map(csvCell).join(";")).join("\r\n")}\r\n`;
}

export function sitesCsv(sites: readonly DossierSite[]): string {
	return csv([
		["Nr", "URL", "Host", "Erfasst (UTC)", "Registriert", "Registrar", "Imitiert", "Sperrmeldungen", "Verbindende Merkmale", "Beweisdateien (SHA-256)", "Fall-ID phishing.support"],
		...sites.map((site, index) => [
			index + 1,
			site.url,
			site.host,
			site.firstSeenAt,
			site.registeredAt ?? "",
			site.registrar ?? "",
			site.impersonates.join(", "),
			site.reports.map((report) => `${report.provider} (${report.target}): ${report.status}${report.reportedAt ? ` ${report.reportedAt}` : ""}${report.confirmationId ? ` #${report.confirmationId}` : ""}`).join(" | "),
			site.indicators.filter((indicator) => indicator.links).map((indicator) => `${indicator.kind}:${indicator.value}`).join(" | "),
			site.evidence.map((file) => `${file.name} ${file.sha256}`).join(" | "),
			site.submissionId,
		]),
	]);
}

export function indicatorsCsv(indicators: readonly DossierIndicator[]): string {
	return csv([
		["Art", "Wert", "Verbindet Seiten", "Beschreibung", "Seiten"],
		...indicators.map((indicator) => [indicator.kind, indicator.value, indicator.links ? "ja" : "nein", describeIndicator(indicator), indicator.sites.join(" | ")]),
	]);
}

/** The dossier as a self-contained text file, without salutation or signature. */
export function dossierText(dossier: Dossier): string {
	return [
		`Dossier Phishing-Kampagne ${dossier.campaignId} (phishing.support), erstellt ${germanDateTime(dossier.generatedAt)}`,
		"",
		`${plural(dossier.sites.length, "Website", "Websites")}, erfasst zwischen ${germanDateTime(dossier.firstSeenAt)} und ${germanDateTime(dossier.lastSeenAt)}. Laufend aktualisierte Übersicht: ${publicCampaignUrl(dossier.campaignId)}`,
		dossier.impersonates.length ? `Imitierte Marken/Dienste: ${dossier.impersonates.join(", ")}.` : "",
		dossier.dataRequested.length ? `Abgefragte Daten: ${dossier.dataRequested.join(", ")}.` : "",
		"",
		"Verbindende Merkmale",
		...indicatorLines(dossier.indicators),
		"",
		"Websites",
		...dossier.sites.map(siteLine),
		"",
		"Ermittlungsansätze bei den Anbietern",
		...providerLines(dossier.providers),
		"",
		"Beweismittel je Website: MHTML-Mitschnitt, Bildschirmfoto, Bildschirmfoto mit eingeblendeter URL und Zeit, Manifest mit SHA-256 aller Dateien und RFC-3161-Zeitstempel einer unabhängigen Zeitstempelstelle über das Manifest. Die Prüfsummen stehen in Websites.csv.",
	].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n").trim();
}
