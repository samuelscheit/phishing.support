/**
 * Authorities a campaign can be referred to. Each entry is checked against
 * the authority's own publication; `source` names it.
 */
export type Authority = {
	id: string;
	name: string;
	email: string;
	postalAddress: string[];
	kind: "prosecutor" | "police";
	/** Why and when to choose it, shown when a referral is prepared. */
	scope: string;
	source: string;
};

export const AUTHORITIES: readonly Authority[] = [
	{
		id: "by-zcb",
		name: "Generalstaatsanwaltschaft Bamberg – Zentralstelle Cybercrime Bayern (ZCB)",
		email: "cybercrime@gensta-ba.bayern.de",
		postalAddress: ["Wörthstr. 7", "96052 Bamberg"],
		kind: "prosecutor",
		scope: "Bayernweit zuständig für herausgehobene Cybercrime-Verfahren; nimmt nach eigener Broschüre Mitteilungen formlos per E-Mail an. Erste Wahl für Kampagnen mit vielen Seiten oder Exfiltrationskanal.",
		source: "https://www.justiz.bayern.de/media/pdf/broschueren/cybercrime_-_hilfe_f%C3%BCr_betroffene_unternehmen_stand_januar_2025.pdf",
	},
	{
		id: "by-zac",
		name: "Bayerisches Landeskriminalamt – Zentrale Ansprechstelle Cybercrime (ZAC)",
		email: "zac@polizei.bayern.de",
		postalAddress: ["Maillingerstr. 15", "80636 München"],
		kind: "police",
		scope: "Polizeiliche Ansprechstelle für Cybercrime in Bayern, vorrangig für Unternehmen und Behörden.",
		source: "https://www.justiz.bayern.de/media/pdf/broschueren/cybercrime_-_hilfe_f%C3%BCr_betroffene_unternehmen_stand_januar_2025.pdf",
	},
	{
		id: "by-sta-muenchen-1",
		name: "Staatsanwaltschaft München I",
		email: "poststelle@sta-m1.bayern.de",
		postalAddress: ["80097 München"],
		kind: "prosecutor",
		scope: "Örtlich zuständig für den Wohnsitz des Anzeigeerstatters (Landkreis München). Rät selbst von Anzeigen per E-Mail ab, weil das Justiznetz Mails blockieren kann; nur mit Zustellbestätigung nutzen.",
		source: "https://www.justiz.bayern.de/gerichte-und-behoerden/staatsanwaltschaft/muenchen-1/kontakt.php",
	},
];

export function authorityById(id: string): Authority | undefined {
	return AUTHORITIES.find((authority) => authority.id === id);
}
