/**
 * How a German authority reaches records held in another state, per state.
 * Every fact is taken from docs/research/cross-border-investigation-instruments.md
 * and docs/research/infrastructure-country-intake.md (status November 2026),
 * which cite the primary sources. A state without an entry gets only what
 * follows from EU membership; nothing is assumed beyond that.
 */

export type Bilingual = { de: string; en: string };

type Budapest = "party" | "signed" | "none";

type CountryFacts = {
	budapest: Budapest;
	/** Facts that change the route for this state, in addition to the generic instruments. */
	notes?: Bilingual[];
	/** Whether phishing.support itself may usefully file a signed complaint there (see the intake research). */
	directComplaint?: Bilingual;
};

/** EU member states, all bound by Regulation (EU) 2023/1543 except Denmark. */
const EU = new Set(["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"]);

const FACTS: Readonly<Record<string, CountryFacts>> = {
	US: {
		budapest: "party",
		notes: [
			{ de: "Anbieter dürfen Bestandsdaten nach 18 U.S.C. § 2702(c)(6) freiwillig an ausländische Behörden herausgeben; ob sie es tun, regelt jeder Anbieter selbst. Ein Ersuchen nach § 2703(f) können nur US-Behörden stellen.", en: "Providers may voluntarily disclose non-content records to foreign authorities under 18 U.S.C. § 2702(c)(6); each provider sets its own policy. Only US authorities can make a § 2703(f) request." },
			{ de: "Rechtshilfevertrag Deutschland–USA (in Kraft seit 2009).", en: "Germany–US mutual legal assistance treaty (in force since 2009)." },
		],
	},
	GB: {
		budapest: "party",
		notes: [
			{ de: "Nicht an die E-Evidence-Verordnung gebunden; freiwillige Sicherung über die 24/7-Kontaktstelle der NCA, danach Rechtshilfe nach dem Handels- und Kooperationsabkommen (Teil 3 Titel VIII). Großbritannien hat Art. 21 EuRhÜbk vorbehalten.", en: "Not bound by the e-Evidence Regulation; voluntary preservation through the NCA 24/7 point, then mutual legal assistance under the Trade and Cooperation Agreement (Part 3 Title VIII). The UK reserved Art. 21 ECMA." },
		],
	},
	CA: {
		budapest: "party",
		notes: [
			{ de: "Kanadische Polizei kann Daten für eine Tat nach ausländischem Recht ohne Richter 90 Tage sichern lassen (Criminal Code s. 487.012); Ersuchen über die 24/7-Kontaktstelle (NC3), danach Rechtshilfevertrag Deutschland–Kanada von 2002.", en: "Canadian police can order data preserved for 90 days for an offence under foreign law, without a judge (Criminal Code s. 487.012); request through the 24/7 point (NC3), then the 2002 Germany–Canada MLA treaty." },
		],
	},
	TR: {
		budapest: "party",
		notes: [
			{ de: "Hoster müssen Verkehrsdaten nach Gesetz Nr. 5651 ein bis zwei Jahre speichern; Sicherung über die 24/7-Kontaktstelle der Cybercrime-Abteilung der Polizei.", en: "Hosters must keep traffic data for one to two years under Law No. 5651; preservation through the police cybercrime department's 24/7 point." },
		],
		directComplaint: { de: "Schriftliche Anzeige (ihbar) auf Türkisch bei der Staatsanwaltschaft am Serverstandort (CMK Art. 158); die Staatsanwaltschaft muss entscheiden und stellt eine Einstellung dem Anzeigenden zu.", en: "A written report (ihbar) in Turkish to the prosecutor where the server is (CMK Art. 158); the prosecutor must decide and serves a dismissal on the reporter." },
	},
	LT: {
		budapest: "party",
		directComplaint: { de: "Unterschriebene Anzeige (qualifizierte Signatur oder Brief) an die Cybercrime-Einheit der Kriminalpolizei, cyberpolice@policija.lt (BPK Art. 166); eine Ablehnung ist zu begründen und anfechtbar.", en: "A signed report (qualified signature or letter) to the Criminal Police Bureau's cybercrime unit, cyberpolice@policija.lt (CPC Art. 166); a refusal must be reasoned and can be appealed." },
	},
	NL: { budapest: "party" },
	FR: {
		budapest: "party",
		notes: [{ de: "Für große Fälle die Cybercrime-Abteilung J3 der Staatsanwaltschaft Paris (landesweit zuständig).", en: "For large cases, section J3 (cybercrime) of the Paris prosecutor's office, which has nationwide jurisdiction." }],
	},
	IE: {
		budapest: "signed",
		notes: [{ de: "Irland hat die Budapest-Konvention nur gezeichnet und nimmt an der Europäischen Ermittlungsanordnung nicht teil; Herausgabeanordnungen nach der E-Evidence-Verordnung kann es empfangen.", en: "Ireland has only signed the Budapest Convention and does not take part in the European Investigation Order; it can receive e-Evidence production orders." }],
	},
	SG: {
		budapest: "none",
		notes: [{ de: "Kein Rechtshilfevertrag mit Deutschland; Rechtshilfe auf Gegenseitigkeit (MACMA s. 16), polizeilich über BKA, Interpol und das Arbeitsabkommen mit Europol.", en: "No MLA treaty with Germany; assistance on reciprocity (MACMA s. 16), police contact through the BKA, Interpol and Singapore's working arrangement with Europol." }],
	},
	CN: {
		budapest: "none",
		notes: [{ de: "Kein Rechtshilfevertrag mit Deutschland; chinesisches Recht (Datensicherheitsgesetz Art. 36) verbietet die Herausgabe an ausländische Behörden ohne Genehmigung. Realistisch nur Sperrung über CNCERT und den Anbieter.", en: "No MLA treaty with Germany; Chinese law (Data Security Law Art. 36) forbids handing data to foreign authorities without approval. Realistically only takedown through CNCERT and the provider." }],
	},
	HK: {
		budapest: "none",
		notes: [{ de: "Das Rechtshilfeabkommen Deutschland–Hongkong ist seit 2020 ausgesetzt.", en: "The Germany–Hong Kong MLA agreement has been suspended since 2020." }],
	},
	RU: {
		budapest: "none",
		notes: [{ de: "Zusammenarbeit seit 2022 faktisch eingestellt; nur Sperrung über den Anbieter. Keine Anzeige mit Namen des Anzeigenden dorthin.", en: "Cooperation effectively frozen since 2022; takedown through the provider only. Never file a complaint there that names the reporter." }],
	},
	IN: {
		budapest: "none",
		notes: [{ de: "Hoster müssen Protokolle 180 Tage und Kundendaten von Cloud-Kunden 5 Jahre aufbewahren (CERT-In-Richtlinie 2022); Weg über BKA und Interpol zur CBI.", en: "Hosters must keep logs for 180 days and cloud customers' identity data for 5 years (CERT-In directions 2022); route through the BKA and Interpol to the CBI." }],
	},
};

const NAMES_DE = new Intl.DisplayNames(["de"], { type: "region" });
const NAMES_EN = new Intl.DisplayNames(["en"], { type: "region" });

export function countryName(code: string): Bilingual {
	return { de: NAMES_DE.of(code) ?? code, en: NAMES_EN.of(code) ?? code };
}

export function isEuMemberState(code: string): boolean {
	return EU.has(code);
}

/**
 * The instruments that reach records held in this state, from a German
 * authority's side: the EU production order, preservation through the 24/7
 * network, and what the state's own law adds.
 */
export function countryRoutes(code: string): Bilingual[] {
	if (code === "DE") {
		return [{ de: "Herausgabeverlangen nach § 95 StPO, Bestandsdaten nach § 100j StPO.", en: "Production orders under § 95 StPO, subscriber data under § 100j StPO." }];
	}
	const facts = FACTS[code];
	const routes: Bilingual[] = [];
	if (EU.has(code) && code !== "DK") {
		routes.push({ de: "EU-Staat: Europäische Herausgabeanordnung (VO (EU) 2023/1543) direkt an den Anbieter. Eine Europäische Sicherungsanordnung kann Deutschland derzeit nicht erlassen.", en: "EU member state: European Production Order (Regulation (EU) 2023/1543) directly to the provider. Germany cannot yet issue European Preservation Orders." });
	}
	const budapest = facts?.budapest ?? (EU.has(code) ? "party" : undefined);
	if (budapest === "party") {
		routes.push({ de: "Vertragsstaat der Budapest-Konvention: Sicherung über die 24/7-Kontaktstelle des BKA (Art. 29), danach Rechtshilfe.", en: "Party to the Budapest Convention: preservation through the BKA's 24/7 point (Art. 29), then mutual legal assistance." });
	} else if (budapest === "none") {
		routes.push({ de: "Kein Vertragsstaat der Budapest-Konvention: keine beschleunigte Sicherung über das 24/7-Netz.", en: "Not a party to the Budapest Convention: no expedited preservation through the 24/7 network." });
	} else if (budapest === undefined) {
		routes.push({ de: "Rechtshilfeweg für diesen Staat noch nicht geprüft.", en: "The legal route to this state has not been checked yet." });
	}
	routes.push(...facts?.notes ?? []);
	return routes;
}

/** A complaint phishing.support can file there itself, where one is realistic. */
export function directComplaint(code: string): Bilingual | undefined {
	return FACTS[code]?.directComplaint;
}
