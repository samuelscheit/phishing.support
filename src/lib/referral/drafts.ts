import { serviceIdentity } from "../constants";
import { publicCampaignUrl } from "../campaign/urls";
import type { Authority } from "./authorities";
import type { Complainant } from "./complainant";
import type { Dossier, DossierSite } from "./dossier";
import { countryAnnexes } from "./annex";
import { infrastructureLines } from "./infrastructure";
import { germanDate, germanDateTime, indicatorLines, siteLine } from "./render";

/** Sites listed in a mail body; the attached CSV always has all of them. */
const MAX_SITES_IN_MAIL = 25;

export type ReferralDraft = { subject: string; body: string };

type DraftContext = {
	dossier: Dossier;
	complainant: Complainant;
	/** The case tag every mail of the referral report carries, e.g. `PS-0a1b2c3d`. */
	caseTag: string;
	download: { url: string; expiresAt: Date };
};

const SERVICE = new URL(serviceIdentity.url).host;

/**
 * Mails speak for phishing.support as an organization ("wir"); the person
 * who signs is named as the complainant and contact, because an authority
 * answers only a natural person. No legal form is claimed.
 */
function signature(complainant: Complainant): string[] {
	return [
		"Mit freundlichen Grüßen",
		"",
		complainant.name,
		SERVICE,
		...complainant.addressLines,
		...(complainant.phone ? [`Telefon: ${complainant.phone}`] : []),
	];
}

function siteList(sites: readonly DossierSite[]): string[] {
	const listed = sites.slice(0, MAX_SITES_IN_MAIL).map(siteLine);
	const rest = sites.length - listed.length;
	return rest > 0 ? [...listed, `… und ${rest} weitere in der Anlage sites.csv.`] : listed;
}

function campaignSummary(dossier: Dossier, sites: readonly DossierSite[]): string {
	const one = sites.length === 1;
	const brands = dossier.impersonates.length ? ` ${one ? "Sie gibt" : "Sie geben"} sich als ${dossier.impersonates.join(", ")} aus.` : "";
	const data = dossier.dataRequested.length ? ` Besucher sollen dort ${dossier.dataRequested.join(", ")} eingeben.` : "";
	const firstSeen = sites.map((site) => site.firstSeenAt).sort();
	const when = one
		? `Die Website wurde am ${germanDateTime(firstSeen[0] ?? dossier.firstSeenAt)} erfasst.`
		: `Die ${sites.length} Websites wurden zwischen ${germanDateTime(firstSeen[0] ?? dossier.firstSeenAt)} und ${germanDateTime(firstSeen.at(-1) ?? dossier.lastSeenAt)} erfasst.`;
	return `${when}${brands}${data}`;
}

function evidenceParagraph(download: DraftContext["download"]): string[] {
	return [
		"Beweismittel",
		"Für jede Website liegen ein MHTML-Mitschnitt, ein Bildschirmfoto mit eingeblendeter URL und Uhrzeit, ein Manifest mit den SHA-256-Prüfsummen aller Dateien und ein RFC-3161-Zeitstempel einer unabhängigen Zeitstempelstelle über dieses Manifest vor. Wo unser Browser die Seite mit synthetischen Werten durchlaufen hat, belegt ein ebenso zeitgestempeltes Besuchsprotokoll (visit-protocol.txt, visit-record.json), welcher Wert wann in welches Feld eingegeben wurde und welche Anfrage ihn wohin übertrug, mit vollständigem Inhalt und der Antwort des Servers. Die Prüfsummen stehen in der Anlage sites.csv. Das ZIP-Archiv enthält die Dateien und je Website eine Auswertung (analysis.txt: warum die Seite Phishing ist, was eingegeben und wohin es gesendet wurde); Archiv und Auswertungen sind englisch, damit sie auch Anbieter und ausländische Stellen lesen können. Herunterladen können Sie es hier:",
		download.url,
		`(Der Link ist bis ${germanDate(download.expiresAt.toISOString())} gültig. Auf Wunsch übermitteln wir die Dateien auch auf anderem Weg.)`,
	];
}

/**
 * The criminal complaint against persons unknown for one campaign. Every
 * fact in it comes from the dossier; the text names no suspect and claims no
 * damage that was not observed.
 */
export function complaintDraft(context: DraftContext & { authority: Authority }): ReferralDraft {
	const { dossier, complainant, authority } = context;
	const sites = dossier.sites;
	const linking = indicatorLines(dossier.indicators);
	const subject = `Strafanzeige gegen Unbekannt – Phishing-Kampagne mit ${sites.length === 1 ? "1 Website" : `${sites.length} Websites`}${dossier.impersonates.length ? ` (${dossier.impersonates.slice(0, 3).join(", ")})` : ""} [${context.caseTag}]`;
	const body = [
		"Sehr geehrte Damen und Herren,",
		"",
		`hiermit erstatten wir für ${SERVICE} Strafanzeige gegen Unbekannt wegen des Verdachts des Computerbetrugs und seiner Vorbereitung (§ 263a Abs. 1 und 3 StGB), der Fälschung beweiserheblicher Daten (§ 269 StGB), des Ausspähens und Abfangens von Daten (§§ 202a, 202b StGB) sowie aller weiteren in Betracht kommenden Straftaten. Anzeigeerstatter und Ansprechpartner ist der Unterzeichnende.`,
		"",
		"Sachverhalt",
		`${SERVICE} nimmt Meldungen zu Phishing-Seiten an, sichert die Seiten als Beweis und meldet sie den Hostern, Registraren und CDN-Anbietern zur Sperrung. Die folgenden Websites werden nach den unten genannten Merkmalen von denselben Tätern betrieben. ${campaignSummary(dossier, sites)}`,
		"",
		"Bei unserer Prüfung wurden ausschließlich synthetische, eigens erzeugte Werte eingegeben; Daten von Opfern wurden weder abgerufen noch verwendet.",
		"",
		`Eine laufend aktualisierte Übersicht aller Websites der Kampagne mit dem Stand der Sperrungen: ${publicCampaignUrl(dossier.campaignId)}`,
		"",
		...(linking.length ? ["Verbindende Merkmale", ...linking, ""] : []),
		"Websites",
		...siteList(sites),
		"",
		"Ermittlungsansätze und Datensicherung",
		"Die Anbieter haben die Seiten teils schon gesperrt; nach einer Sperrung löschen sie Konto-, Zahlungs- und Zugriffsdaten oft binnen Tagen. Wir haben jeden Anbieter gebeten, die Daten aufzubewahren, können eine Sicherung aber nicht erzwingen. Wir regen an, die Daten bei folgenden Anbietern zu sichern. Sie sind nach dem Staat geordnet, in dem das Unternehmen sitzt, das die Kundendaten hält; dazu die Instrumente, die dort greifen:",
		...infrastructureLines(dossier.infrastructure, "de"),
		...annexSentence(dossier),
		"",
		...evidenceParagraph(context.download),
		"",
		"Weiteres Vorgehen",
		`Bitte teilen Sie uns das Aktenzeichen mit. Neue Websites derselben Kampagne würden wir als Nachtrag zu diesem Verfahren übersenden; bitte nennen Sie uns dafür, wenn möglich, eine Ansprechperson oder eine Adresse. Antworten auf diese E-Mail erreichen uns direkt. Sollte die Anzeige bei ${authority.name} nicht richtig sein, bitten wir um Weiterleitung an die zuständige Stelle.`,
		"",
		"Anlagen: sites.csv (alle Websites mit Einstufung und Prüfsummen der Beweisdateien), indicators.csv (alle Merkmale mit Fundstellen)",
		"",
		...signature(complainant),
	].join("\n");
	return { subject, body };
}

/** Points the authority to the per-state annexes in the archive, when there are any. */
function annexSentence(dossier: Dossier): string[] {
	const annexes = countryAnnexes(dossier);
	if (!annexes.length) return [];
	return ["", `Für ${annexes.length === 1 ? "den ausländischen Staat liegt" : `jeden der ${annexes.length} ausländischen Staaten liegt`} im ZIP-Archiv ein englischer Anhang (${annexes.map((annex) => annex.fileName).join(", ")}): die Infrastruktur dort mit allen Kennungen und Zeiträumen, vorausgefüllte Angaben für ein Sicherungsersuchen nach Art. 29 Budapest-Konvention und, für EU-Staaten, für eine Europäische Herausgabeanordnung, sowie der Wortlaut der Straftatbestände auf Deutsch und Englisch.`];
}

/** New sites of a campaign already reported, sent to the same authority under its file number. */
export function supplementDraft(context: DraftContext & { authority: Authority; caseReference?: string; newSites: readonly DossierSite[]; complaintSentAt?: string }): ReferralDraft {
	const { dossier, complainant, newSites } = context;
	const reference = context.caseReference ? `Az. ${context.caseReference}` : `unserer Anzeige vom ${context.complaintSentAt ? germanDate(context.complaintSentAt) : "(Datum)"}`;
	const newUrls = new Set(newSites.map((site) => site.url));
	const newIndicators = dossier.indicators.filter((indicator) => indicator.sites.some((url) => newUrls.has(url)));
	const subject = `Nachtrag zu ${reference} – ${newSites.length === 1 ? "1 weitere Website" : `${newSites.length} weitere Websites`} der Phishing-Kampagne [${context.caseTag}]`;
	const body = [
		"Sehr geehrte Damen und Herren,",
		"",
		`zu ${reference} übersenden wir ${newSites.length === 1 ? "eine weitere Website" : `${newSites.length} weitere Websites`} derselben Kampagne. ${campaignSummary(dossier, newSites)} Die Kampagne umfasst damit ${dossier.sites.length} Websites; die Übersicht aller Websites: ${publicCampaignUrl(dossier.campaignId)}`,
		"",
		...(newIndicators.length ? ["Merkmale, die die neuen Websites mit der Kampagne verbinden", ...indicatorLines(newIndicators), ""] : []),
		"Neue Websites",
		...siteList(newSites),
		"",
		"Ermittlungsansätze und Datensicherung, nach Staaten",
		...infrastructureLines(dossier.infrastructure, "de"),
		...annexSentence(dossier),
		"",
		...evidenceParagraph(context.download),
		"",
		"Anlagen: sites.csv (alle Websites der Kampagne), indicators.csv",
		"",
		...signature(complainant),
	].join("\n");
	return { subject, body };
}

/**
 * Ask a provider to keep the records of the sites we reported to it, now
 * that an authority has the case. Only an authority can compel this; the
 * notice gives the provider the file number and a lawful reason to keep the
 * data until the authority's request arrives. It asks for nothing to be
 * disclosed to us.
 */
export function preservationNoticeDraft(params: {
	recipient: string;
	recipientLabel: string;
	authority: Authority;
	caseReference: string;
	sites: readonly DossierSite[];
	complainant: Complainant;
	caseTag: string;
}): ReferralDraft {
	const { sites } = params;
	const subject = `Data preservation request – criminal case ${params.caseReference} – ${sites.length === 1 ? sites[0]!.host : `${sites.length} phishing sites`} [${params.caseTag}]`;
	const reported = sites.map((site) => {
		const report = site.reports.find((candidate) => candidate.contact?.toLowerCase() === params.recipient.toLowerCase());
		return `- ${site.url}${report?.reportedAt ? ` (reported to you on ${report.reportedAt.slice(0, 10)}${report.confirmationId ? `, ticket ${report.confirmationId}` : ""})` : ""}`;
	});
	const body = [
		`Hello ${params.recipientLabel} team,`,
		"",
		`We reported the phishing ${sites.length === 1 ? "site" : "sites"} below to you for takedown. A criminal complaint about the campaign behind ${sites.length === 1 ? "it" : "them"} is now pending with the German authority ${params.authority.name} under file number ${params.caseReference}.`,
		"",
		...reported,
		"",
		"Please preserve every record you hold about the accounts behind these sites for at least 90 days: account and subscriber data, payment records, login and access logs with IP addresses, and the hosted content or a server image. Please suspend rather than delete. A request from law enforcement will reach you through the official channels.",
		"",
		"We are not asking you to disclose any of these records to us. Please reply to confirm that the data is preserved.",
		"",
		"Regards,",
		params.complainant.name,
		SERVICE,
	].join("\n");
	return { subject, body };
}
