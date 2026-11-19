/** The German wording of the complaint mails to German authorities; the evidence archive has its own English texts (archive_text.ts). */
import { operatorServerRoles } from "../campaign/schema";
import type { DossierIndicator, DossierSite } from "./dossier";
import { plural, record, text } from "./format";

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

const RECEIVER_LABEL: Readonly<Record<string, string>> = { iban: "IBAN", bitcoin: "Bitcoin-Adresse", tron: "TRON-Adresse", ethereum: "Ethereum-Adresse" };

/** One indicator as a sentence an investigator can act on. */
export function describeIndicator(indicator: DossierIndicator): string {
	const evidence = indicator.evidence;
	const reach = `(${plural(indicator.sites.length, "Seite", "Seiten")})`;
	if (indicator.kind === "operator_server") {
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
		const roles = operatorServerRoles(evidence);
		const delivered = record(evidence.delivered);
		const does = [
			roles.includes("receives_data") && `empfängt die Eingaben der Besucher${text(evidence.endpointUrl) ? ` über ${evidence.method ?? "POST"} ${evidence.endpointUrl}` : ""}${observed}`,
			roles.includes("delivers_malware") && `liefert die Schadsoftware, die Besucher ${delivered.via === "offered_download" ? "herunterladen" : "ausführen"} sollen${text(delivered.url) ? `, z. B. ${delivered.url}` : ""}${text(delivered.sha256) ? ` (SHA-256 ${delivered.sha256})` : ""}`,
		].filter(Boolean).join(" und ");
		return `Server ${indicator.value.replace(/^host:/, "")} ${does} ${reach}.`;
	}
	if (indicator.kind === "payment_receiver") {
		const kind = text(evidence.receiverKind) ?? "";
		return `${RECEIVER_LABEL[kind] ?? "Zahlungsempfänger"} ${text(evidence.receiver) ?? indicator.value} wird Besuchern als Zahlungsziel genannt ${reach}.`;
	}
	if (indicator.kind === "kit_fingerprint") {
		if (evidence.fileKind === "page_structure") return `Identische Seitenvorlage (dieselben ${evidence.tags ?? "?"} HTML-Elemente in derselben Reihenfolge, ohne Text und Attribute; SHA-256 ${indicator.value}) ${reach}.`;
		if (evidence.fileKind === "page_document") return `Identischer Seiteninhalt (HTML-Body, ${evidence.size ?? "?"} Byte; die eigene Adresse der Seite ausgeblendet; SHA-256 ${indicator.value}) ${reach}.`;
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
