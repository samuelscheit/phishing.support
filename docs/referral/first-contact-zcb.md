# First contact: Zentralstelle Cybercrime Bayern (prepared, not sent)

**Recipient:** Generalstaatsanwaltschaft Bamberg – Zentralstelle Cybercrime Bayern (ZCB), `cybercrime@gensta-ba.bayern.de` (Wörthstr. 7, 96052 Bamberg; phone 0951 833-1451). Source: Bavarian justice ministry brochure "Cybercrime – Hilfe für betroffene Unternehmen", January 2025.

**Send from** `support@phishing.support`, so the reply lands in the service's mailbox.

**Before sending:**

1. Deploy, then run "Rebuild campaigns" under `/operator/campaigns`.
2. Fill in `[Link]` with the public page of the example campaign. It is the campaign of `policy-trust-assurance.onrender.com`.
3. Attach its dossier ZIP, which the operator page offers for download.
4. Fill in address and phone.

**Facts behind the numbers** (production database, 2026-11-17):

- 283 websites confirmed as phishing and 38 phishing mails since January 2026, 274 of the websites since July. Websites per month: Jul 47, Aug 22, Sep 142, Oct 30, Nov so far 33.
- About 800 takedown reports to providers, counting the reports that are submitted, acknowledged or awaiting a reply.
- **The example campaign:**
  - 9 sites, all `*.onrender.com`;
  - captured on 15.11.2026 between 01:32 and 02:20 (German time), one new subdomain about every 10 minutes;
  - the same kit files on every site, with a German-language lure ("Da die Zugänglichkeit Ihrer Seite eingeschränkt ist …");
  - e-mail address and password are sent by POST to `/api/send` of each site;
  - every site was reported to Render and Netcraft.

---

**Betreff:** phishing.support – Phishing-Kampagnen: Bitte um Ansprechpartner für Strafanzeigen

Sehr geehrte Damen und Herren,

phishing.support ist ein unabhängiger, nicht kommerzieller Dienst gegen Phishing. Er wird von mir, Samuel Scheit, betrieben und privat finanziert. Wir erkennen Phishing-Websites, sichern sie als Beweis und lassen sie von Hostern, Registraren und CDN-Anbietern sperren. Seit Januar 2026 haben wir 283 Phishing-Websites und 38 Phishing-Mails bestätigt und dazu rund 800 Sperrmeldungen an Anbieter geschickt.

**Warum wir uns an Sie wenden**

Wir erkennen Kampagnen meist früh, bevor viele Menschen ihre Daten eingeben, und die Seiten werden gesperrt. Wenige Stunden später steht dieselbe Seite unter neuer Adresse wieder online. Die Täter bleiben unbehelligt, weil eine Sperrung niemanden zur Verantwortung zieht. Uns sind deshalb keine einzelnen Geschädigten bekannt, wohl aber dieselben Täter immer wieder. Wir möchten erreichen, dass gegen sie ermittelt wird.

Ein Beispiel: Am 15.11.2026 haben wir zwischen 01:32 und 02:20 Uhr neun Phishing-Seiten erfasst, alle beim US-Hoster Render. Etwa alle zehn Minuten kam eine neue Subdomain hinzu, jede mit denselben Programmdateien. Die Seiten zeigen einen deutschsprachigen Hinweis („Da die Zugänglichkeit Ihrer Seite eingeschränkt ist …“) und senden die eingegebene E-Mail-Adresse und das Passwort an den eigenen Server. Die Übersicht der Kampagne mit allen Seiten und dem Stand der Sperrungen: [Link]. Das vollständige Dossier mit den Beweisdateien liegt bei.

**Was wir liefern können**

Je Kampagne eine Strafanzeige gegen Unbekannt. Sie enthält:

- alle Seiten mit Zeitpunkt, Registrar, Hoster und Stand der Sperrung;
- die Merkmale, die die Seiten verbinden: identische Programmdateien, derselbe Telegram-Bot oder Sammelserver, an den die Eingaben gehen, dieselben Zahlungsempfänger;
- für jeden Anbieter, welche Konto-, Zahlungs- und Zugriffsdaten dort liegen und auf welchem Weg sie sich sichern lassen, etwa über die Europäische Sicherungsanordnung oder ein Ersuchen nach US-Recht.

Die Täter sitzen fast immer im Ausland; das Dossier soll die nötigen Ersuchen erleichtern. Neue Seiten derselben Kampagne würden wir als Nachtrag unter Ihrem Aktenzeichen schicken.

Jede Seite sichern wir automatisiert mit einem eigenen Browser:

- MHTML-Mitschnitt;
- Bildschirmfoto mit eingeblendeter URL und Uhrzeit;
- Manifest mit den SHA-256-Prüfsummen aller Dateien;
- RFC-3161-Zeitstempel einer unabhängigen Zeitstempelstelle über dieses Manifest.

Wir rufen dabei nur öffentlich erreichbare Inhalte ab. Wo wir prüfen, wohin eine Seite Eingaben schickt, geben wir ausschließlich eigens erzeugte Testwerte ein. Die Originale bewahren wir unbefristet auf unserem eigenen Server auf. Ich stehe als Zeuge zur Verfügung.

**Unsere Fragen**

1. Sind Sie für solche Kampagnen-Anzeigen die richtige Stelle, oder sollen wir sie an die örtlich zuständige Polizei oder Staatsanwaltschaft richten? phishing.support wird aus [Ort], Landkreis München, betrieben.
2. Viele Kampagnen haben keinen erkennbaren Tatort in Deutschland: Täter und Server sind im Ausland, die Seiten zielen aber auf deutschsprachige Nutzer oder deutsche Marken. Führen Sie solche Verfahren selbst, oder geben Sie sie an die ZIT bei der Generalstaatsanwaltschaft Frankfurt am Main oder an das BKA ab? Sollen wir solche Kampagnen dann direkt dorthin richten, und an welche Adresse?
3. Können Sie uns eine Ansprechperson oder ein Funktionspostfach für Anzeigen und Nachträge nennen?
4. Wir lassen Seiten sofort sperren, um Opfer zu schützen. Damit erfahren die Täter auch, dass sie entdeckt sind. Sollen wir bei Kampagnen, zu denen ein Verfahren läuft, Meldungen an Anbieter auf Ihren Wunsch zurückhalten oder mit Ihnen abstimmen?
5. In welcher Form sollen die Beweismittel kommen? Vorgesehen sind CSV-Anhänge mit allen Seiten und Prüfsummen sowie ein ZIP-Archiv über einen zeitlich begrenzten Download-Link. Falls Ihr Netz solche Links oder Anhänge sperrt, nennen Sie uns bitte einen anderen Weg.
6. Sollen wir die Anbieter um vorsorgliche Datensicherung bitten, sobald ein Aktenzeichen vorliegt, mit Hinweis auf das Verfahren? Oder veranlassen Sie das selbst?

Wir haben uns mit diesem Anliegen bisher an keine andere Behörde gewandt. Gern stellen wir den Dienst auch in einem kurzen Telefonat vor.

Mit freundlichen Grüßen

Samuel Scheit
phishing.support – https://phishing.support
[Straße Hausnummer]
[PLZ Ort]
Telefon: [Telefon]
