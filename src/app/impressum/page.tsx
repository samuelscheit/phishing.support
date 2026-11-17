import type { Metadata } from "next";
import Link from "next/link";

import { LegalPage, OperatorAddress } from "@/components/LegalPage";

export const metadata: Metadata = {
	title: "Impressum",
	description: "Anbieterkennzeichnung von Phishing Support nach § 5 DDG.",
	alternates: { canonical: "/impressum" },
};

export default function ImpressumPage() {
	return (
		<LegalPage title="Impressum" englishNote="Legal notice (provider identification under German law). Phishing Support is run by Samuel Scheit as a private, non-commercial service.">
			<h2>Anbieter nach § 5 DDG</h2>
			<OperatorAddress />
			<p>Phishing Support ist ein privates, nicht kommerzielles Angebot ohne eigene Rechtsform.</p>

			<h2>Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV</h2>
			<OperatorAddress />

			<h2>Meldungen zu Inhalten</h2>
			<p>
				Kampagnenseiten und Analysen entstehen automatisch aus den Websites und E-Mails, die uns gemeldet werden. Wenn Sie meinen, dass wir
				Sie zu Unrecht nennen, etwa als Inhaber einer gehackten Website, eines missbrauchten Kontos oder eines gefälschten Absenders,
				schreiben Sie uns an die oben genannte Adresse; wir prüfen das umgehend.
			</p>

			<p>
				Wie wir mit personenbezogenen Daten umgehen, steht in der{" "}
				<Link href="/datenschutz" className="underline hover:text-primary">
					Datenschutzerklärung
				</Link>
				.
			</p>
		</LegalPage>
	);
}
