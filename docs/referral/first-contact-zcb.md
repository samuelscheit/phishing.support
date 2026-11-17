# First contact: Zentralstelle Cybercrime Bayern (prepared, not sent)

**Recipient:** Generalstaatsanwaltschaft Bamberg – Zentralstelle Cybercrime Bayern (ZCB), `cybercrime@gensta-ba.bayern.de` (Wörthstr. 7, 96052 Bamberg; phone 0951 833-1451). Source: Bavarian justice ministry brochure "Cybercrime – Hilfe für betroffene Unternehmen", January 2025.

**Send from** `support@phishing.support`, so the reply lands in the service's mailbox.

**Before sending:** fill in street and phone (the `[…]` placeholders). The evidence archive is linked, not attached: at about 30 MB it is too large for most authority mail gateways.

**Facts behind the numbers** (production database, 2026-11-17):

- 283 websites confirmed as phishing and 38 phishing mails since January 2026, 274 of the websites since July. Websites per month: Jul 47, Aug 22, Sep 142, Oct 30, Nov so far 33.
- About 800 takedown reports to providers, counting the reports that are submitted, acknowledged or awaiting a reply.
- **The example campaign** (`https://phishing.support/campaigns/381039186385310339`, "Fake Meta page-restriction notices"):
  - all sites `*.onrender.com/help`, the same kit files on every site;
  - first wave on 15.11.2026 between 01:32 and 02:34 (German time): 12 sites, one new subdomain about every 10 minutes;
  - second wave since 17.11.2026, 16:22 (German time): 16 more sites so far, found from the kit of the first;
  - the lure shows each visitor a Meta notice in their own language that their page is restricted (seen in German, Dutch and Swedish);
  - the visit on 17.11.2026, 16:14–16:19, recorded with an RFC 3161 timestamp that the site asks for name, page name, e-mail, phone, password and a one-time code, and sends e-mail, password and code by POST to its own `/api/send` five times;
  - every site was reported to Render and Netcraft.

---

**Betreff:** phishing.support – Phishing-Kampagnen: Bitte um Ansprechpartner für Strafanzeigen

Sehr geehrte Damen und Herren,

phishing.support ist ein unabhängiger, nicht kommerzieller Dienst gegen Phishing. Er wird von mir, Samuel Scheit, betrieben und privat finanziert. Wir erkennen Phishing-Websites, sichern sie als Beweis und lassen sie von Hostern, Registraren und CDN-Anbietern sperren. Seit Januar 2026 haben wir 283 Phishing-Websites und 38 Phishing-Mails bestätigt und dazu rund 800 Sperrmeldungen an Anbieter geschickt.

**Warum wir uns an Sie wenden**

Wir erkennen Kampagnen meist früh, bevor viele Menschen ihre Daten eingeben, und die Seiten werden gesperrt. Wenige Stunden später steht dieselbe Seite unter neuer Adresse wieder online. Die Täter bleiben unbehelligt, weil eine Sperrung niemanden zur Verantwortung zieht. Uns sind deshalb keine einzelnen Geschädigten bekannt, wohl aber dieselben Täter immer wieder. Wir möchten erreichen, dass gegen sie ermittelt wird.

Ein Beispiel: Am 15.11.2026 haben wir zwischen 01:32 und 02:34 Uhr zwölf Phishing-Seiten erfasst, alle beim US-Hoster Render. Etwa alle zehn Minuten kam eine neue Subdomain hinzu, jede mit denselben Programmdateien. Die Seiten geben sich als Meta (Facebook) aus und melden jedem Besucher in seiner Sprache, seine Seite sei gesperrt; wir haben die Seiten auf Deutsch, Niederländisch und Schwedisch gesehen. Seit dem 17.11.2026, 16:22 Uhr, läuft eine zweite Welle mit bislang 16 weiteren Seiten. Unser Browser hat eine davon mit Testwerten durchlaufen: Die Seite fragt nacheinander Name, Seitenname, E-Mail-Adresse, Telefonnummer, Passwort und einen Einmalcode ab und hat E-Mail-Adresse, Passwort und Code fünfmal an ihren eigenen Server geschickt. Das ist mit Zeitstempel protokolliert.

Die Übersicht der Kampagne mit allen Seiten, ihren Bildschirmfotos und dem Stand der Sperrungen: https://phishing.support/campaigns/381039186385310339
Das Beweisarchiv (ZIP, etwa 30 MB, Texte auf Englisch): https://phishing.support/campaigns/381039186385310339/evidence.zip

**Was wir liefern können**

Je Kampagne eine Strafanzeige gegen Unbekannt. Sie enthält:

- alle Seiten mit Zeitpunkt, Registrar, Hoster und Stand der Sperrung;
- die Merkmale, die die Seiten verbinden: identische Programmdateien, derselbe Telegram-Bot oder Sammelserver, an den die Eingaben gehen, dieselben Zahlungsempfänger;
- für jeden Anbieter, welche Konto-, Zahlungs- und Zugriffsdaten dort liegen, welches Unternehmen sie vertraglich hält und auf welchem Weg sie sich erreichen lassen, etwa über eine Europäische Herausgabeanordnung (VO (EU) 2023/1543) an den EU-Adressaten des Anbieters oder über ein Sicherungsersuchen der 24/7-Kontaktstelle;
- nach Ländern geordnet, wo die Infrastruktur steht (Server, Vertragspartner, Netzbetreiber) und welche Instrumente dort greifen.

Die Täter sitzen fast immer im Ausland; das Dossier soll die nötigen Ersuchen erleichtern. Den echten Hoster hinter Cloudflare erfahren wir oft aus Cloudflares Antwort auf unsere Meldung; darunter sind auffällig häufig Hoster in Großbritannien, St. Kitts und Nevis oder Malaysia, die sich auf solche Kunden spezialisiert zu haben scheinen. Neue Seiten derselben Kampagne würden wir als Nachtrag unter Ihrem Aktenzeichen schicken.

Jede Seite sichern wir automatisiert mit einem eigenen Browser:

- MHTML-Mitschnitt;
- Bildschirmfoto mit eingeblendeter URL und Uhrzeit;
- Manifest mit den SHA-256-Prüfsummen aller Dateien;
- RFC-3161-Zeitstempel einer unabhängigen Zeitstempelstelle über dieses Manifest.

Wir rufen dabei nur öffentlich erreichbare Inhalte ab. Wo wir prüfen, wohin eine Seite Eingaben schickt, geben wir ausschließlich eigens erzeugte Testwerte ein. Die Originale bewahren wir unbefristet auf unserem eigenen Server auf. Ich stehe als Zeuge zur Verfügung.

**Unsere Fragen**

1. Sind Sie für solche Kampagnen-Anzeigen die richtige Stelle, oder sollen wir sie an die örtlich zuständige Polizei oder Staatsanwaltschaft richten? phishing.support wird aus Aschheim, Landkreis München, betrieben.
2. Viele Kampagnen haben keinen erkennbaren Tatort in Deutschland: Täter und Server sind im Ausland, die Seiten zielen aber auf deutschsprachige Nutzer oder deutsche Marken. Führen Sie solche Verfahren selbst, oder geben Sie sie an die ZIT bei der Generalstaatsanwaltschaft Frankfurt am Main oder an das BKA ab? Sollen wir solche Kampagnen dann direkt dorthin richten, und an welche Adresse?
3. Können Sie uns eine Ansprechperson oder ein Funktionspostfach für Anzeigen und Nachträge nennen?
4. Wir lassen Seiten sofort sperren, um Opfer zu schützen. Damit erfahren die Täter auch, dass sie entdeckt sind. Sollen wir bei Kampagnen, zu denen ein Verfahren läuft, Meldungen an Anbieter auf Ihren Wunsch zurückhalten oder mit Ihnen abstimmen?
5. In welcher Form sollen die Beweismittel kommen? Vorgesehen sind CSV-Anhänge mit allen Seiten und Prüfsummen sowie ein ZIP-Archiv über einen zeitlich begrenzten Download-Link. Falls Ihr Netz solche Links oder Anhänge sperrt, nennen Sie uns bitte einen anderen Weg.
6. Sollen wir die Anbieter um vorsorgliche Datensicherung bitten, sobald ein Aktenzeichen vorliegt, mit Hinweis auf das Verfahren? Oder veranlassen Sie das selbst? Manche Anbieter löschen Kundendaten schon 30 Tage nach Vertragsende.
7. Nutzen Sie bei Kampagnen, deren Infrastruktur in mehreren Staaten liegt, Eurojust oder gemeinsame Ermittlungsgruppen (JIT), oder geben Sie Verfahren an den Staat des Hosters ab (Anzeige zum Zwecke der Strafverfolgung, Nr. 145 ff. RiVASt)? Uns geht es darum, dass die Behörden vor Ort die Kunden- und Zahlungsdaten der Hoster mit eigenen Anordnungen erheben können.
8. Wäre Ihnen ein vorbereiteter Anhang je Staat hilfreich: in Englisch, mit der dort gelegenen Infrastruktur, dem Zeitraum, dem Vertragspartner des Anbieters und den Angaben, die eine Europäische Herausgabeanordnung oder ein Sicherungsersuchen über die 24/7-Kontaktstelle braucht? Wenn ja, in welcher Form, und sollen wir zusätzlich maschinenlesbare Indikatoren (CSV, MISP/STIX) mitliefern?

Wir haben uns mit diesem Anliegen bisher an keine andere Behörde gewandt. Gern stellen wir den Dienst auch in einem kurzen Telefonat vor.

Mit freundlichen Grüßen

Samuel Scheit
phishing.support – https://phishing.support
[Straße Hausnummer]
85609 Aschheim
Telefon: [Telefon]
