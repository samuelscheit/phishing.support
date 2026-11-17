import type { Metadata } from "next";

import { LegalPage, OPERATOR, OperatorAddress } from "@/components/LegalPage";

export const metadata: Metadata = {
	title: "Datenschutzerklärung",
	description: "Wie Phishing Support personenbezogene Daten verarbeitet: Meldungen, Daten über Phishing-Seiten und ihre Betreiber, Kampagnenseiten, Weitergabe an Anbieter und Behörden.",
	alternates: { canonical: "/datenschutz" },
};

const mail = <a href={`mailto:${OPERATOR.email}`} className="underline hover:text-primary">{OPERATOR.email}</a>;

export default function DatenschutzPage() {
	return (
		<LegalPage title="Datenschutzerklärung" englishNote="Privacy policy. It explains what Phishing Support processes about people who report phishing, about the people and accounts behind phishing sites, and about visitors of this website. Questions in English are welcome.">
			<h2>1. Verantwortlicher</h2>
			<OperatorAddress />
			<p>Ein Datenschutzbeauftragter ist nicht benannt.</p>

			<h2>2. Was Phishing Support tut</h2>
			<p>
				Phishing Support analysiert Phishing-E-Mails und Phishing-Websites, sichert sie als Beweis, meldet sie den Unternehmen, die sie hosten,
				registrieren oder ausliefern, damit sie gesperrt werden, und zeigt Phishing-Kampagnen bei Strafverfolgungsbehörden an. Kampagnen und
				Analysen veröffentlichen wir, um die Öffentlichkeit zu warnen und Sperrungen nachvollziehbar zu machen.
			</p>

			<h2>3. Wenn Sie uns eine E-Mail oder einen Link melden</h2>
			<ul>
				<li>
					<strong>Daten:</strong> die gemeldete E-Mail mit Kopfzeilen, Inhalt und Anhängen oder der gemeldete Link; bei einer weitergeleiteten
					E-Mail Ihre Absenderadresse; bei einer Meldung über diese Website Ihre IP-Adresse, das daraus abgeleitete Land und die technischen
					Angaben Ihres Browsers (Request-Header).
				</li>
				<li>
					<strong>Zweck:</strong> den Phishing-Versuch analysieren, zur Sperrung melden und die Strafverfolgung ermöglichen; die IP-Adresse
					und die Browserangaben dienen dem Schutz vor Missbrauch des Meldewegs.
				</li>
				<li>
					<strong>Rechtsgrundlage:</strong> Art. 6 Abs. 1 lit. f DSGVO. Unser Interesse und das der Betroffenen ist es, dass Phishing gestoppt
					und verfolgt wird.
				</li>
				<li>
					<strong>Veröffentlichung:</strong> Analysen gemeldeter E-Mails und Websites sind öffentlich. Ihre Adresse als Empfänger der
					Phishing-Mail entfernen wir aus der öffentlichen Darstellung. Melden Sie bitte nur, was Sie weitergeben dürfen.
				</li>
			</ul>

			<h2>4. Daten über Phishing-Seiten und die Personen dahinter</h2>
			<ul>
				<li>
					<strong>Daten:</strong> Domains, Registrierungsdaten, IP-Adressen und Netze, Absenderadressen von Phishing-Mails, die Konten und
					Kanäle, an die eine Seite die eingegebenen Daten schickt (etwa Telegram-Bots, Discord-Webhooks, Sammelserver), und
					Zahlungsangaben, die eine Seite nennt (etwa IBANs und Krypto-Adressen). Wir erheben sie aus den Phishing-Seiten selbst, aus
					öffentlichen Registern (RDAP/WHOIS, RIPEstat) und aus Antworten der Anbieter. Bei unseren Besuchen geben wir ausschließlich eigens
					erzeugte Testwerte ein.
				</li>
				<li>
					<strong>Daten zu Straftaten:</strong> Diese Angaben können sich auf Straftaten beziehen (Art. 10 DSGVO).
				</li>
				<li>
					<strong>Zweck:</strong> Sperrung der Seiten, Verhinderung weiterer Betrugsfälle, Warnung der Öffentlichkeit und Strafverfolgung.
				</li>
				<li>
					<strong>Rechtsgrundlage:</strong> Art. 6 Abs. 1 lit. f DSGVO, für Strafanzeigen in Verbindung mit § 158 StPO und für Meldungen an
					Hosting-Anbieter in Verbindung mit Art. 16 der Verordnung (EU) 2022/2065 (Digital Services Act).
				</li>
				<li>
					<strong>Veröffentlichung:</strong> Kampagnenseiten nennen die Merkmale, die Phishing-Seiten miteinander und mit ihren Betreibern
					verbinden, einschließlich der Empfänger der eingegebenen Daten und der genannten Zahlungsangaben. Ein öffentliches Beweisarchiv
					enthält die gesicherten Seiten. So können Betroffene, Banken, Anbieter und Forschende die Kampagne erkennen und prüfen.
				</li>
				<li>
					<strong>Unbeteiligte:</strong> Manche dieser Angaben gehören Menschen, die selbst Opfer sind, etwa Inhabern eines missbrauchten
					Kontos oder einer gehackten Website. Wenn Sie betroffen sind, schreiben Sie an {mail}; wir prüfen das umgehend und berichtigen oder
					entfernen die Angaben.
				</li>
				<li>
					<strong>Keine Benachrichtigung im Einzelfall:</strong> Die Betreiber von Phishing-Seiten informieren wir nicht einzeln. Das würde den
					Zweck, Straftaten zu verhindern und zu verfolgen, vereiteln (Art. 14 Abs. 5 lit. b DSGVO, § 33 Abs. 1 Nr. 2 lit. b BDSG). Diese
					Erklärung ist die öffentliche Information nach § 33 Abs. 2 BDSG.
				</li>
			</ul>

			<h2>5. Empfänger</h2>
			<ul>
				<li>
					<strong>Anbieter der Phishing-Infrastruktur:</strong> Hoster, Registrare, CDN- und Plattformbetreiber; jeder erhält die Angaben zu
					den eigenen Kunden und Diensten.
				</li>
				<li>
					<strong>Sperr- und Warndienste:</strong> Netcraft Ltd (Großbritannien) und Google Safe Browsing (Google LLC, USA) erhalten die
					Adressen der Phishing-Seiten.
				</li>
				<li>
					<strong>Strafverfolgungsbehörden:</strong> deutsche Staatsanwaltschaften und Polizeibehörden, vor allem die Zentralstelle Cybercrime
					Bayern. Ausländische Behörden erhalten Daten nur über die deutschen Behörden.
				</li>
				<li>
					<strong>Auftragsverarbeiter:</strong> OpenAI und Anthropic (USA) für die automatische Analyse von E-Mails und Websites; Cloudflare,
					Inc. (USA) für die Auslieferung dieser Website. Heruntergeladene Schadsoftware übermitteln wir zur Prüfung an VirusTotal (Google
					LLC).
				</li>
			</ul>

			<h2>6. Übermittlung in Drittstaaten</h2>
			<p>
				Viele Anbieter der Phishing-Infrastruktur sitzen außerhalb der EU. Ist das Empfängerland durch einen Angemessenheitsbeschluss erfasst
				oder der Empfänger nach dem EU-U.S. Data Privacy Framework zertifiziert, stützen wir die Übermittlung auf Art. 45 DSGVO. Sonst
				übermitteln wir nur, was der Anbieter braucht, um die Phishing-Seite seines Kunden zu sperren, gestützt auf Art. 49 Abs. 1 lit. d
				DSGVO: Die Verhinderung und Verfolgung von Computerbetrug ist ein wichtiges öffentliches Interesse, das das deutsche Recht anerkennt.
			</p>

			<h2>7. Besuch dieser Website</h2>
			<ul>
				<li>
					Beim Aufruf verarbeiten Cloudflare und unser Server technisch notwendige Verbindungsdaten (IP-Adresse, Zeitpunkt, aufgerufene Adresse,
					Browserangaben), um die Website auszuliefern und zu schützen (Art. 6 Abs. 1 lit. f DSGVO).
				</li>
				<li>
					Wir setzen keine Analyse- oder Werbedienste ein. Die Liste der Meldungen speichert Ihre Filtereinstellungen im Speicher Ihres Browsers
					(localStorage); sie verlassen Ihr Gerät nicht. Das ist für die von Ihnen gewünschte Funktion erforderlich (§ 25 Abs. 2 Nr. 2 TDDDG).
					Nur der Betreiber meldet sich mit einem Cookie an.
				</li>
			</ul>

			<h2>8. Speicherdauer</h2>
			<ul>
				<li>
					Beweismittel und Meldungen zu Kampagnen, die wir angezeigt haben, bewahren wir auf, bis die Verfolgung der Taten verjährt ist: in der
					Regel 5 Jahre, bei banden- oder gewerbsmäßigem Betrug 10 Jahre nach der letzten Seite der Kampagne.
				</li>
				<li>Übrige Meldungen und Analysen bewahren wir auf, solange sie helfen, neue Seiten derselben Täter zu erkennen.</li>
				<li>Kampagnenseiten bleiben öffentlich, solange sie zur Warnung beitragen; auf begründeten Widerspruch entfernen wir einzelne Angaben.</li>
			</ul>

			<h2>9. Ihre Rechte</h2>
			<p>
				Sie haben das Recht auf Auskunft (Art. 15 DSGVO), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung der Verarbeitung (Art. 18)
				und Widerspruch gegen eine Verarbeitung nach Art. 6 Abs. 1 lit. f (Art. 21), soweit §§ 33 und 34 BDSG sie nicht einschränken, weil
				sonst die Verfolgung von Straftaten gefährdet würde. Schreiben Sie dazu an {mail}.
			</p>
			<p>
				Sie können sich bei der Aufsichtsbehörde beschweren: Bayerisches Landesamt für Datenschutzaufsicht, Promenade 18, 91522 Ansbach.
			</p>
		</LegalPage>
	);
}
