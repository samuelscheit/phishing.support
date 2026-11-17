/**
 * The German offences a phishing campaign is reported under, in the wording
 * a foreign authority needs (RiVASt requires the text of the provisions):
 * the authoritative German text and the Federal Ministry of Justice's
 * English translation, both verbatim as published on gesetze-im-internet.de
 * (retrieved 2026-11-17). The translation is not binding.
 */
export type Offence = { section: string; titleDe: string; titleEn: string; textDe: string; textEn: string; sourceDe: string };

export const OFFENCES: readonly Offence[] = [
	{
		section: "263a",
		titleDe: "Computerbetrug",
		titleEn: "Computer fraud",
		textDe: [
			"(1) Wer in der Absicht, sich oder einem Dritten einen rechtswidrigen Vermögensvorteil zu verschaffen, das Vermögen eines anderen dadurch beschädigt, daß er das Ergebnis eines Datenverarbeitungsvorgangs durch unrichtige Gestaltung des Programms, durch Verwendung unrichtiger oder unvollständiger Daten, durch unbefugte Verwendung von Daten oder sonst durch unbefugte Einwirkung auf den Ablauf beeinflußt, wird mit Freiheitsstrafe bis zu fünf Jahren oder mit Geldstrafe bestraft.",
			"(2) § 263 Abs. 2 bis 6 gilt entsprechend.",
			"(3) Wer eine Straftat nach Absatz 1 vorbereitet, indem er",
			"1. Computerprogramme, deren Zweck die Begehung einer solchen Tat ist, herstellt, sich oder einem anderen verschafft, feilhält, verwahrt oder einem anderen überlässt oder",
			"2. Passwörter oder sonstige Sicherungscodes, die zur Begehung einer solchen Tat geeignet sind, herstellt, sich oder einem anderen verschafft, feilhält, verwahrt oder einem anderen überlässt,",
			"wird mit Freiheitsstrafe bis zu drei Jahren oder mit Geldstrafe bestraft.",
			"(4) In den Fällen des Absatzes 3 gilt § 149 Abs. 2 und 3 entsprechend.",
		].join("\n"),
		textEn: [
			"(1) Whoever, with the intent of obtaining an unlawful pecuniary benefit for themselves or a third party, damages the property of another by influencing the result of a data processing operation by incorrectly configuring the computer program, using incorrect or incomplete data, making unauthorised use of data or taking other unauthorised influence on the processing operation incurs a penalty of imprisonment for a term not exceeding five years or a fine.",
			"(2) Section 263 (2) to (6) applies accordingly.",
			"(3) Whoever prepares an offence under subsection (1) by",
			"1. producing computer programs the purpose of which is to commit such an act or procures such programs for themselves or another, or",
			"2. producing, procuring for themselves or another, offering for sale, storing or supplying to another passwords or other security codes suited to committing such an act",
			"incurs a penalty of imprisonment for a term not exceeding three years or a fine.",
			"(4) In the cases under subsection (3), section 149 (2) and (3) applies accordingly.",
		].join("\n"),
		sourceDe: "https://www.gesetze-im-internet.de/stgb/__263a.html",
	},
	{
		section: "269",
		titleDe: "Fälschung beweiserheblicher Daten",
		titleEn: "Forgery of data of probative value",
		textDe: [
			"(1) Wer zur Täuschung im Rechtsverkehr beweiserhebliche Daten so speichert oder verändert, daß bei ihrer Wahrnehmung eine unechte oder verfälschte Urkunde vorliegen würde, oder derart gespeicherte oder veränderte Daten gebraucht, wird mit Freiheitsstrafe bis zu fünf Jahren oder mit Geldstrafe bestraft.",
			"(2) Der Versuch ist strafbar.",
			"(3) § 267 Abs. 3 und 4 gilt entsprechend.",
		].join("\n"),
		textEn: [
			"(1) Whoever, for the purposes of deception in legal commerce, stores or modifies data which are of probative value in such a way that a counterfeit or falsified document would be created upon their retrieval, or whoever uses data stored or modified in such a manner incurs a penalty of imprisonment for a term not exceeding five years or a fine.",
			"(2) The attempt is punishable.",
			"(3) Section 267 (3) and (4) applies accordingly.",
		].join("\n"),
		sourceDe: "https://www.gesetze-im-internet.de/stgb/__269.html",
	},
	{
		section: "202a",
		titleDe: "Ausspähen von Daten",
		titleEn: "Data espionage",
		textDe: [
			"(1) Wer unbefugt sich oder einem anderen Zugang zu Daten, die nicht für ihn bestimmt und die gegen unberechtigten Zugang besonders gesichert sind, unter Überwindung der Zugangssicherung verschafft, wird mit Freiheitsstrafe bis zu drei Jahren oder mit Geldstrafe bestraft.",
			"(2) Daten im Sinne des Absatzes 1 sind nur solche, die elektronisch, magnetisch oder sonst nicht unmittelbar wahrnehmbar gespeichert sind oder übermittelt werden.",
		].join("\n"),
		textEn: [
			"(1) Whoever, without being authorised to do so, obtains access, by circumventing the access protection, for themselves or another, to data which were not intended for them and were specially protected against unauthorised access incurs a penalty of imprisonment for a term not exceeding three years or a fine.",
			"(2) For the purposes of subsection (1), data are only those which are stored or transmitted electronically, magnetically or otherwise in a manner which is not immediately perceptible.",
		].join("\n"),
		sourceDe: "https://www.gesetze-im-internet.de/stgb/__202a.html",
	},
	{
		section: "202b",
		titleDe: "Abfangen von Daten",
		titleEn: "Phishing",
		textDe: "Wer unbefugt sich oder einem anderen unter Anwendung von technischen Mitteln nicht für ihn bestimmte Daten (§ 202a Abs. 2) aus einer nichtöffentlichen Datenübermittlung oder aus der elektromagnetischen Abstrahlung einer Datenverarbeitungsanlage verschafft, wird mit Freiheitsstrafe bis zu zwei Jahren oder mit Geldstrafe bestraft, wenn die Tat nicht in anderen Vorschriften mit schwererer Strafe bedroht ist.",
		textEn: "Whoever, without being authorised to do so, intercepts data (section 202a (2)) which are not intended for them, either for themselves or another, by technical means from non-public data transmission or from an electromagnetic broadcast from a data processing facility incurs a penalty of imprisonment for a term not exceeding two years or a fine, unless the offence is subject to a more severe penalty under other provisions.",
		sourceDe: "https://www.gesetze-im-internet.de/stgb/__202b.html",
	},
];

export const OFFENCES_TRANSLATION_SOURCE = "https://www.gesetze-im-internet.de/englisch_stgb/englisch_stgb.html";
