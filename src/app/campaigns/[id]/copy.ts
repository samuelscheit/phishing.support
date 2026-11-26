/**
 * Everything the public campaign page says to a visitor, in each language.
 * The steps are built from what the campaign's pages ask for and from the
 * impersonated brand's validated account links; without a brand or a link
 * they fall back to wording that needs neither.
 */
import type { Locale } from "@/lib/i18n/locale";
import type { GuidancePurpose, PublicCampaignVisitor, VisitorKind } from "@/lib/campaign/public_view";

export type Tone = "safe" | "warn" | "danger";
/** What a visitor did on the page: the kinds they may have typed, or only opening it. */
export type StepKind = "opened" | VisitorKind;
/** `first`: the step's most urgent action, set apart. `fact`: something to know rather than to do. */
export type Action = { text: string; url?: string; first?: boolean; fact?: boolean };
/** `short`: what was typed, for the button that reveals collapsed steps. */
export type GuideStep = { kind: StepKind; did: string; gets: string; tone: Tone; actions: Action[]; short: string };

type Brand = PublicCampaignVisitor["brand"];
type Links = Partial<Record<GuidancePurpose, string>>;

const TONE: Record<StepKind, Tone> = { opened: "safe", email: "warn", password: "danger", code: "danger", phone: "danger", card: "danger", payment: "danger", personal: "warn" };

/**
 * What typing these kinds put at risk: an account (a password, or a code on
 * a sign-in page) or money (a card, a payment, or a code that approves one
 * on any other page, as the steps describe it).
 */
function exposure(kinds: readonly VisitorKind[], basis: Basis): { account: boolean; money: boolean } {
	const bankCode = basis !== "credentials" && kinds.includes("code");
	return {
		account: kinds.includes("password") || (kinds.includes("code") && !bankCode),
		money: kinds.includes("card") || kinds.includes("payment") || bankCode,
	};
}

/** A link action when the brand's validated link exists, the same words as plain advice when not. */
function linked(text: string, url: string | undefined, plain: string): Action {
	return url ? { text, url } : { text: plain };
}

const EN = {
	headline: (brand: string | undefined, basis: Basis, fallback: string) => !brand ? fallback : basis === "payment" ? `Fake ${brand} payment pages` : basis === "credentials" ? `Fake ${brand} sign-in pages` : `Fake ${brand} pages`,
	verdict: (n: number): string => n === 1 ? "This site is fake. Do not enter anything there." : "These sites are fake. Do not enter anything there.",
	lede: (n: number, brand: string | undefined, basis: Basis) => {
		const subject = n === 1 ? "This site copies" : `These ${n} sites copy`;
		if (!brand) return `${n === 1 ? "This site is" : `These ${n} sites are`} made to steal what visitors type in.`;
		return basis === "payment" ? `${subject} ${brand} to get your payment details.` : basis === "credentials" ? `${subject} ${brand}'s sign-in page to take over accounts.` : `${subject} ${brand} to steal what visitors type in.`;
	},
	trust: (brand: string | undefined) => `Phishing Support is an independent service that gets fake sites taken down.${brand ? ` We are not ${brand}.` : ""}`,
	today: "today",
	yesterday: "yesterday",
	daysAgo: (n: number) => `${n} days ago`,
	hostBanner: (host: string) => `${host} is one of these fake sites. Do not enter anything there.`,
	whatToDoButton: "Typed something in? What to do",
	yourSite: "Your site",
	facts: (n: number, platform: string | undefined, languages: number) => [n === 1 ? "1 site" : `${n} sites`, platform && n > 1 ? `all on ${platform}` : undefined, languages > 1 ? `${languages} languages` : undefined].filter(Boolean).join(" · "),
	activeBadge: (ago: string) => `Active · newest site ${ago}`,
	quietBadge: (date: string) => `No new sites since ${date}`,
	howFar: "What did you type in?",
	howFarSub: "Pick the furthest you got.",
	doFirst: "Do this first:",
	/** What was typed, on the buttons that pick a step. */
	short: { opened: "Nothing", email: "My email", password: "My password", code: "A code", phone: "A phone number", card: "Card details", payment: "A payment", personal: "Personal details" } satisfies Record<StepKind, string>,
	verdictTitle: (finding: "phishing" | "malware", basis: Basis): string => finding === "malware" ? "Malware distribution" : basis === "credentials" ? "Phishing: credential theft" : basis === "payment" ? "Phishing: payment fraud" : "Phishing",
	impersonates: "Impersonates",
	officialSite: "official site",
	tellApart: "How to tell them apart",
	asksFor: "Asks for",
	kind: { email: "Email address", password: "Password", code: "One-time code", phone: "Phone number", card: "Card details", payment: "Payment", personal: "Personal details" } satisfies Record<VisitorKind, string>,
	evidence: "Evidence",
	quoteFrom: (host: string) => `from ${host}`,
	takedown: "Takedown",
	takedownSub: (down: number, total: number, reported: number) => `${down} of ${total} taken down · ${reported === total ? "every site reported" : `${reported} reported`}`,
	notReported: "Not reported yet",
	siteOf: (index: number, total: number) => `Site ${index} of ${total}`,
	previousSite: "Previous site",
	nextSite: "Next site",
	fakeStamp: "Fake · do not enter anything",
	pagesCaptured: (n: number) => n === 1 ? "1 page captured" : `${n} pages captured`,
	openCase: "Open case",
	tabSites: (n: number) => `Sites (${n})`,
	tabTimeline: "Timeline",
	tabLinks: "How they're linked",
	tabTechnical: "Technical",
	tabEvidence: "Evidence",
	linksSub: "Why we think the same people run all these sites.",
	ofSites: (k: number, n: number) => `${k} of ${n}`,
	filterAll: (n: number) => `All ${n}`,
	searchPlaceholder: "Paste your link: is it one of them?",
	searchHit: (host: string) => `${host} is one of these fake sites. Do not enter anything there; if you already did, see “What did you type in?”.`,
	searchMiss: (domain: string | undefined) => `Not one of these sites. That alone does not make it safe${domain ? `: if unsure, open ${domain} yourself` : ""}.`,
	site: "Site",
	language: "Language",
	status: "Status",
	files: (n: number) => n === 1 ? "1 file" : `${n} files`,
	screenshotAlt: (host: string) => `Screenshot of the fake site ${host}`,
	/** Steps by kind; email, code and phone read as an account sign-in only on sign-in pages, elsewhere as what they are on a payment or data form. */
	steps: (brand: Brand, basis: Basis): Record<StepKind, Omit<GuideStep, "kind" | "tone" | "short">> => {
		const name = brand?.name;
		const links: Links = brand?.links ?? {};
		const typeIt = brand ? `type ${brand.domain} into the address bar` : "type the real site's address into the address bar";
		const secure: Action[] = [
			{ text: `Open a new tab, ${typeIt}, sign in and change your password. If you can't sign in, recover your account${links.recover ? " (link below)" : " through the real site"}.`, first: true },
			linked("Sign out every device you don't know", links.devices, "In your account settings, sign out every device you don't know."),
			...(links.recover ? [{ text: "Can't sign in any more? Recover your account", url: links.recover }] : []),
		];
		const notSignIn = basis === "credentials" ? {} : {
			email: { did: "You typed your email address", gets: "The criminals now know your email address is real.", actions: [
				{ text: `Expect fake emails and texts that look like they come from ${name ?? "the real company"} or your bank.`, first: true },
				{ text: "Never pay or sign in through a link in an email or text." },
			] },
			code: { did: "You typed a code from your bank (by text or in your banking app)", gets: "This code can approve a payment from your card or account.", actions: [
				{ text: "Call your bank now on the number printed on your card.", first: true },
				{ text: "Check your statements and dispute every payment you don't know." },
			] },
			phone: { did: "You typed your phone number", gets: `Expect calls and texts pretending to be ${name ?? "the company"} or your bank.`, actions: [
				{ text: "Never give anyone a code on the phone. Hang up and call your bank yourself.", first: true },
			] },
		};
		return {
			opened: { did: "You only opened the page", gets: "Nothing has happened. Close the tab, you are done.", actions: [] },
			email: { did: "You typed your email address (or phone number) on the first screen to sign in", gets: "The criminals now know your email address or number is real.", actions: [
				{ text: `Never sign in through a link in an email or text. ${brand ? `Type ${brand.domain}` : "Type the real site's address"} into the address bar at the top of your browser yourself.`, first: true },
				{ text: `Expect fake emails and texts that look like they come from ${name ?? "the real company"}.`, fact: true },
			] },
			password: { did: "You typed your password, or aren't sure", gets: "The criminals have your password. Without 2-step verification they can sign in as you right away.", actions: [
				...secure,
				{ text: "Change it everywhere else you use the same password." },
			] },
			code: { did: `You typed the code ${name ?? "the company"} sent you by text or in the app`, gets: "The criminals may already be in your account: this code lets them sign in as you.", actions: secure },
			phone: { did: "Later the page asked for a phone number to “verify” you, and you entered one", gets: `The criminals can call or text you pretending to be ${name ?? "the company"}, to get a sign-in code from you. If they got into your account, they may have added their own number.`, actions: [
				{ text: "Remove any phone number or recovery email in your account that isn't yours.", first: true },
				...(links.security && name ? [{ text: `Open your ${name} security settings`, url: links.security }] : []),
				{ text: `If someone calls about a code: hang up. ${name ?? "No real company"} never calls you to ask for one.` },
			] },
			card: { did: "You typed your card details", gets: "The criminals can pay with your card.", actions: [
				{ text: "Call your bank now on the number printed on your card and have the card blocked.", first: true },
				{ text: "Check your statements and dispute every payment you don't know." },
			] },
			payment: { did: "You paid or sent money through the page", gets: `The money went to the criminals, not to ${name ?? "the company"}.`, actions: [
				{ text: "Call your bank right away: a transfer can sometimes still be stopped within hours.", first: true },
				{ text: "Report it to the police. The evidence on this page can help them." },
			] },
			personal: { did: "You typed personal details such as your name, address or date of birth", gets: "The criminals can use them to pose as you, or to make their next scam more convincing.", actions: [
				{ text: "Be suspicious of calls, letters and emails that already know these details.", first: true },
				{ text: "If you sent a photo of your ID, report it to the police." },
			] },
			...notSignIn,
		};
	},
	afterwards: "If you typed anything, also do this today",
	/** Account steps only where an account can be taken over, money steps only where money or a card was involved. */
	afterwardsActions: (brand: Brand, kinds: readonly VisitorKind[], basis: Basis): Action[] => {
		const links: Links = brand?.links ?? {};
		const { account, money } = exposure(kinds, basis);
		return [
			...(account && links.activity && brand ? [{ text: `Check “Recent security activity” in your ${brand.name} account`, url: links.activity }] : []),
			...(account && links.forwarding ? [{ text: "Remove email forwarding or filters you didn't set up", url: links.forwarding }] : []),
			...(account ? [linked("Turn on 2-step verification with an app or a passkey", links.security, "Turn on 2-step verification with an app or a passkey.")] : []),
			...(money ? [{ text: "Watch your bank and card statements over the next weeks." }, { text: "Your bank never asks for codes or passwords on the phone. Hang up on such calls." }] : []),
			...(kinds.includes("email") ? [{ text: "Keep an eye on bank and shopping accounts that use this email address." }] : []),
			...(account ? [{ text: "If scam emails went out in your name, warn your contacts." }] : []),
		];
	},
	linksNote: (domain: string) => `All links above lead to ${domain}.`,
	ruleSignIn: (brand: string, signIn: string) => `${brand}'s sign-in is only ever ${signIn}. A sign-in page anywhere else is fake, even if the address contains “${brand.toLowerCase()}”.`,
	ruleGeneric: (brand: string, domain: string) => `Fake sites use addresses that have nothing to do with ${brand}. If you are unsure, do not use the link: open ${domain} yourself.`,
	real: "Real",
	fake: "Fake",
	firstSeen: "First seen",
	takenDown: "Taken down",
	notTakenDown: "Not taken down yet",
	noPicture: "No picture",
	when: "When they appeared",
	down: (down: number, total: number) => `${down} of ${total} taken down`,
	dot: (host: string, date: string, down: boolean) => `${host}, ${date}, ${down ? "taken down" : "not taken down yet"}`,
	more: (n: number, date: string) => `${n} more sites from around ${date}`,
	axisEnd: "today",
	technicalNote: "",
	back: "Phishing Support",
	/** The card on a case page that leads to its campaign. */
	caseCard: (n: number) => n > 1 ? `One of ${n} fake sites from the same group` : "A fake site",
	caseCardButton: (n: number) => n > 1 ? `See all ${n} sites and what to do` : "What to do",
	/** Search results: the headline with the first addresses, so a search for one of them matches. */
	metaTitle: (headline: string, hosts: string[]) => `${headline}: ${hosts.slice(0, 2).join(", ")}${hosts.length > 2 ? ` and ${hosts.length - 2} more` : ""}`,
	metaDescription: (hosts: string[], verdict: string) => `${hosts.slice(0, 3).join(", ")}${hosts.length > 3 ? ` and ${hosts.length - 3} more` : ""}: ${verdict} What the criminals get and what to do if you typed something in.`,
};

type Copy = typeof EN;

const DE: Copy = {
	headline: (brand, basis) => !brand ? "Gefälschte Seiten" : basis === "payment" ? `Gefälschte ${brand}-Zahlungsseiten` : basis === "credentials" ? `Gefälschte ${brand}-Anmeldeseiten` : `Gefälschte ${brand}-Seiten`,
	verdict: (n) => n === 1 ? "Diese Seite ist gefälscht. Geben Sie dort nichts ein." : "Diese Seiten sind gefälscht. Geben Sie dort nichts ein.",
	lede: (n, brand, basis) => {
		const subject = n === 1 ? "Diese Seite kopiert" : `Diese ${n} Seiten kopieren`;
		if (!brand) return `${n === 1 ? "Diese Seite soll" : `Diese ${n} Seiten sollen`} abgreifen, was Besucher eingeben.`;
		return basis === "payment" ? `${subject} ${brand}, um an Ihre Zahlungsdaten zu kommen.` : basis === "credentials" ? `${subject} die Anmeldeseite von ${brand}, um Konten zu übernehmen.` : `${subject} ${brand}, um abzugreifen, was Besucher eingeben.`;
	},
	trust: (brand) => `Phishing Support ist ein unabhängiger Dienst, der gefälschte Seiten abschalten lässt.${brand ? ` Wir sind nicht ${brand}.` : ""}`,
	today: "heute",
	yesterday: "gestern",
	daysAgo: (n) => `vor ${n} Tagen`,
	hostBanner: (host) => `${host} ist eine dieser gefälschten Seiten. Geben Sie dort nichts ein.`,
	whatToDoButton: "Etwas eingegeben? Das ist zu tun",
	yourSite: "Ihre Seite",
	facts: (n, platform, languages) => [n === 1 ? "1 Seite" : `${n} Seiten`, platform && n > 1 ? `alle auf ${platform}` : undefined, languages > 1 ? `${languages} Sprachen` : undefined].filter(Boolean).join(" · "),
	activeBadge: (ago) => `Aktiv · neueste Seite ${ago}`,
	quietBadge: (date) => `Keine neuen Seiten seit ${date}`,
	howFar: "Was haben Sie eingegeben?",
	howFarSub: "Wählen Sie, wie weit Sie gekommen sind.",
	doFirst: "Zuerst:",
	short: { opened: "Nichts", email: "Meine E-Mail", password: "Mein Passwort", code: "Einen Code", phone: "Eine Telefonnummer", card: "Kartendaten", payment: "Eine Zahlung", personal: "Persönliche Daten" },
	verdictTitle: (finding, basis) => finding === "malware" ? "Verbreitung von Schadsoftware" : basis === "credentials" ? "Phishing: Diebstahl von Zugangsdaten" : basis === "payment" ? "Phishing: Zahlungsbetrug" : "Phishing",
	impersonates: "Gibt sich aus als",
	officialSite: "offizielle Seite",
	tellApart: "So unterscheiden Sie sie",
	asksFor: "Fragt nach",
	kind: { email: "E-Mail-Adresse", password: "Passwort", code: "Einmalcode", phone: "Telefonnummer", card: "Kartendaten", payment: "Zahlung", personal: "Persönliche Daten" },
	evidence: "Beleg",
	quoteFrom: (host) => `von ${host}`,
	takedown: "Abschaltung",
	takedownSub: (down, total, reported) => `${down} von ${total} abgeschaltet · ${reported === total ? "jede Seite gemeldet" : `${reported} gemeldet`}`,
	notReported: "Noch nicht gemeldet",
	siteOf: (index, total) => `Seite ${index} von ${total}`,
	previousSite: "Vorherige Seite",
	nextSite: "Nächste Seite",
	fakeStamp: "Gefälscht · nichts eingeben",
	pagesCaptured: (n) => n === 1 ? "1 Seite erfasst" : `${n} Seiten erfasst`,
	openCase: "Fall öffnen",
	tabSites: (n) => `Seiten (${n})`,
	tabTimeline: "Zeitverlauf",
	tabLinks: "Was sie verbindet",
	tabTechnical: "Technisches",
	tabEvidence: "Beweise",
	linksSub: "Warum wir glauben, dass dieselben Leute hinter all diesen Seiten stecken (auf Englisch).",
	ofSites: (k, n) => `${k} von ${n}`,
	filterAll: (n) => `Alle ${n}`,
	searchPlaceholder: "Link einfügen: Ist er einer davon?",
	searchHit: (host) => `${host} ist eine dieser gefälschten Seiten. Geben Sie dort nichts ein; haben Sie es schon getan, lesen Sie „Was haben Sie eingegeben?“.`,
	searchMiss: (domain) => `Keine dieser Seiten. Das allein heißt nicht, dass sie sicher ist${domain ? `: Im Zweifel öffnen Sie ${domain} selbst` : ""}.`,
	site: "Seite",
	language: "Sprache",
	status: "Status",
	files: (n) => n === 1 ? "1 Datei" : `${n} Dateien`,
	screenshotAlt: (host) => `Bildschirmfoto der gefälschten Seite ${host}`,
	steps: (brand, basis) => {
		const name = brand?.name;
		const links: Links = brand?.links ?? {};
		const typeIt = brand ? `tippen Sie ${brand.domain} in die Adresszeile` : "tippen Sie die Adresse der echten Seite in die Adresszeile";
		const secure: Action[] = [
			{ text: `Öffnen Sie einen neuen Tab, ${typeIt}, melden Sie sich an und ändern Sie Ihr Passwort. Klappt die Anmeldung nicht, stellen Sie Ihr Konto wieder her${links.recover ? " (Link unten)" : " über die echte Seite"}.`, first: true },
			linked("Melden Sie alle unbekannten Geräte ab", links.devices, "Melden Sie in Ihren Kontoeinstellungen alle unbekannten Geräte ab."),
			...(links.recover ? [{ text: "Kommen Sie nicht mehr hinein? Stellen Sie Ihr Konto wieder her", url: links.recover }] : []),
		];
		const notSignIn = basis === "credentials" ? {} : {
			email: { did: "Sie haben Ihre E-Mail-Adresse eingegeben", gets: "Die Täter wissen jetzt, dass Ihre E-Mail-Adresse echt ist.", actions: [
				{ text: `Rechnen Sie mit gefälschten Mails und SMS, die aussehen, als kämen sie von ${name ?? "der echten Firma"} oder Ihrer Bank.`, first: true },
				{ text: "Bezahlen oder melden Sie sich nie über einen Link in einer Mail oder SMS an." },
			] },
			code: { did: "Sie haben einen Code Ihrer Bank eingegeben (per SMS oder in der Banking-App)", gets: "Mit diesem Code lässt sich eine Zahlung von Ihrer Karte oder Ihrem Konto freigeben.", actions: [
				{ text: "Rufen Sie sofort Ihre Bank unter der Nummer auf Ihrer Karte an.", first: true },
				{ text: "Prüfen Sie Ihre Abrechnungen und widersprechen Sie jeder Zahlung, die Sie nicht kennen." },
			] },
			phone: { did: "Sie haben Ihre Telefonnummer eingegeben", gets: `Rechnen Sie mit Anrufen und SMS, die vorgeben, von ${name ?? "der Firma"} oder Ihrer Bank zu kommen.`, actions: [
				{ text: "Geben Sie niemandem am Telefon einen Code. Legen Sie auf und rufen Sie Ihre Bank selbst an.", first: true },
			] },
		};
		return {
			opened: { did: "Sie haben die Seite nur geöffnet", gets: "Es ist nichts passiert. Schließen Sie den Tab, mehr ist nicht zu tun.", actions: [] },
			email: { did: "Sie haben auf dem ersten Bildschirm Ihre E-Mail-Adresse (oder Telefonnummer) zur Anmeldung eingegeben", gets: "Die Täter wissen jetzt, dass Ihre E-Mail-Adresse oder Nummer echt ist.", actions: [
				{ text: `Melden Sie sich nie über einen Link in einer Mail oder SMS an. ${brand ? `Tippen Sie ${brand.domain}` : "Tippen Sie die Adresse der echten Seite"} selbst oben in die Adresszeile des Browsers ein.`, first: true },
				{ text: `Rechnen Sie mit gefälschten Mails und SMS, die aussehen, als kämen sie von ${name ?? "der echten Firma"}.`, fact: true },
			] },
			password: { did: "Sie haben Ihr Passwort eingegeben oder sind sich nicht sicher", gets: "Die Täter kennen Ihr Passwort. Ohne Bestätigung in zwei Schritten können sie sich sofort als Sie anmelden.", actions: [
				...secure,
				{ text: "Ändern Sie es überall, wo Sie dasselbe Passwort benutzen." },
			] },
			code: { did: `Sie haben den Code eingegeben, den ${name ?? "die Firma"} per SMS oder in der App geschickt hat`, gets: "Die Täter könnten schon in Ihrem Konto sein: Mit diesem Code können sie sich als Sie anmelden.", actions: secure },
			phone: { did: "Die Seite hat später nach einer Telefonnummer zur „Bestätigung“ gefragt, und Sie haben eine eingegeben", gets: `Die Täter können Sie anrufen oder Ihnen SMS schicken und sich als ${name ?? "die Firma"} ausgeben, um an einen Anmeldecode zu kommen. Waren sie schon in Ihrem Konto, haben sie dort vielleicht ihre eigene Nummer hinterlegt.`, actions: [
				{ text: "Entfernen Sie jede Telefonnummer und Wiederherstellungs-E-Mail in Ihrem Konto, die nicht Ihre ist.", first: true },
				...(links.security && name ? [{ text: `Öffnen Sie Ihre ${name}-Sicherheitseinstellungen`, url: links.security }] : []),
				{ text: `Ruft jemand wegen eines Codes an: Legen Sie auf. ${name ? `${name} fragt` : "Keine echte Firma fragt"} nie am Telefon nach Codes.` },
			] },
			card: { did: "Sie haben Ihre Kartendaten eingegeben", gets: "Die Täter können mit Ihrer Karte bezahlen.", actions: [
				{ text: "Rufen Sie sofort Ihre Bank unter der Nummer auf Ihrer Karte an und lassen Sie die Karte sperren.", first: true },
				{ text: "Prüfen Sie Ihre Abrechnungen und widersprechen Sie jeder Zahlung, die Sie nicht kennen." },
			] },
			payment: { did: "Sie haben über die Seite bezahlt oder Geld überwiesen", gets: `Das Geld ging an die Täter, nicht an ${name ?? "die Firma"}.`, actions: [
				{ text: "Rufen Sie sofort Ihre Bank an: Eine Überweisung lässt sich manchmal innerhalb weniger Stunden noch stoppen.", first: true },
				{ text: "Erstatten Sie Anzeige bei der Polizei. Die Beweise auf dieser Seite können dabei helfen." },
			] },
			personal: { did: "Sie haben persönliche Daten wie Name, Adresse oder Geburtsdatum eingegeben", gets: "Die Täter können sich damit als Sie ausgeben oder ihren nächsten Betrug glaubwürdiger machen.", actions: [
				{ text: "Seien Sie misstrauisch bei Anrufen, Briefen und Mails, die diese Daten schon kennen.", first: true },
				{ text: "Haben Sie ein Foto Ihres Ausweises geschickt, erstatten Sie Anzeige bei der Polizei." },
			] },
			...notSignIn,
		};
	},
	afterwards: "Wenn Sie etwas eingegeben haben, tun Sie heute auch das",
	afterwardsActions: (brand, kinds, basis) => {
		const links: Links = brand?.links ?? {};
		const { account, money } = exposure(kinds, basis);
		return [
			...(account && links.activity && brand ? [{ text: `Prüfen Sie die „Letzten Sicherheitsaktivitäten“ in Ihrem ${brand.name}-Konto`, url: links.activity }] : []),
			...(account && links.forwarding ? [{ text: "Entfernen Sie Mail-Weiterleitungen oder Filter, die Sie nicht angelegt haben", url: links.forwarding }] : []),
			...(account ? [linked("Schalten Sie die Bestätigung in zwei Schritten mit App oder Passkey ein", links.security, "Schalten Sie die Bestätigung in zwei Schritten mit App oder Passkey ein.")] : []),
			...(money ? [{ text: "Prüfen Sie in den nächsten Wochen Ihre Konto- und Kartenabrechnungen." }, { text: "Ihre Bank fragt am Telefon nie nach Codes oder Passwörtern. Legen Sie bei solchen Anrufen auf." }] : []),
			...(kinds.includes("email") ? [{ text: "Behalten Sie Bank- und Shop-Konten im Auge, die diese E-Mail-Adresse nutzen." }] : []),
			...(account ? [{ text: "Wurden in Ihrem Namen Betrugsmails verschickt, warnen Sie Ihre Kontakte." }] : []),
		];
	},
	linksNote: (domain) => `Alle Links oben führen zu ${domain}.`,
	ruleSignIn: (brand, signIn) => `Die Anmeldung von ${brand} läuft nur über ${signIn}. Eine Anmeldeseite unter jeder anderen Adresse ist gefälscht, auch wenn „${brand.toLowerCase()}“ darin vorkommt.`,
	ruleGeneric: (brand, domain) => `Gefälschte Seiten nutzen Adressen, die nichts mit ${brand} zu tun haben. Im Zweifel nutzen Sie den Link nicht, sondern öffnen ${domain} selbst.`,
	real: "Echt",
	fake: "Gefälscht",
	firstSeen: "Zuerst gesehen",
	takenDown: "Abgeschaltet",
	notTakenDown: "Noch nicht abgeschaltet",
	noPicture: "Kein Bild",
	when: "Wann sie aufgetaucht sind",
	down: (down, total) => `${down} von ${total} abgeschaltet`,
	dot: (host, date, down) => `${host}, ${date}, ${down ? "abgeschaltet" : "noch nicht abgeschaltet"}`,
	more: (n, date) => `${n} weitere Seiten um den ${date}`,
	axisEnd: "heute",
	technicalNote: "Diese Angaben für Ermittler, Provider und Forscher gibt es nur auf Englisch.",
	back: "Phishing Support",
	caseCard: (n) => n > 1 ? `Eine von ${n} gefälschten Seiten derselben Gruppe` : "Eine gefälschte Seite",
	caseCardButton: (n) => n > 1 ? `Alle ${n} Seiten und was zu tun ist` : "Was zu tun ist",
	metaTitle: (headline, hosts) => `${headline}: ${hosts.slice(0, 2).join(", ")}${hosts.length > 2 ? ` und ${hosts.length - 2} weitere` : ""}`,
	metaDescription: (hosts, verdict) => `${hosts.slice(0, 3).join(", ")}${hosts.length > 3 ? ` und ${hosts.length - 3} weitere` : ""}: ${verdict} Was die Täter bekommen und was zu tun ist, wenn Sie etwas eingegeben haben.`,
};

export const COPY: Record<Locale, Copy> = { en: EN, de: DE };

/** What the campaign's pages are after, which picks the headline. */
export type Basis = "credentials" | "payment" | "other";

/** The visitor's steps: only opening the page, then each kind the pages ask for, in their order. */
export function guideSteps(locale: Locale, visitor: PublicCampaignVisitor, basis: Basis): GuideStep[] {
	const copy = COPY[locale];
	const steps = copy.steps(visitor.brand, basis);
	return (["opened", ...visitor.kinds] as StepKind[]).map((kind) => ({ kind, tone: TONE[kind], short: copy.short[kind], ...steps[kind] }));
}
