import type { Metadata } from "next";

import { GuidePage } from "@/components/GuidePage";
import { SubmissionForm } from "@/components/SubmissionForm";
import { guideMetadata } from "@/lib/seo/guides";

export const metadata: Metadata = guideMetadata("report-phishing-email", "How to report a phishing email and get it taken down");

export default function ReportPhishingEmailPage() {
	return (
		<GuidePage
			slug="report-phishing-email"
			heading="How to report a phishing email"
			lead="Forward the email to report@phishing.support, or upload it below. It is analyzed within minutes, and if it is phishing, the network it was sent from and every phishing site it links to are reported to the providers that can shut them down."
			tool={<SubmissionForm defaultTab="email" />}
			sections={[
				{
					heading: "1. Forward the email with its headers",
					body: (
						<>
							<p>
								Send the email to <a href="mailto:report@phishing.support">report@phishing.support</a>. The headers show which server really sent it,
								so forward it <strong>as an attachment</strong> where your mail app can:
							</p>
							<ul>
								<li><strong>Outlook:</strong> select the email, then More actions (…) → Forward as attachment.</li>
								<li><strong>Apple Mail:</strong> select the email, then Message → Forward as Attachment.</li>
								<li><strong>Gmail:</strong> open the email, then More (⋮) → Download message, and upload the <code>.eml</code> file in the form above.</li>
							</ul>
							<p>A plain forward works too; the analysis then has less to trace the sender with.</p>
						</>
					),
				},
				{
					heading: "2. What happens to the email",
					body: (
						<ol>
							<li>Your own address and other personal details are removed from the email before it is stored.</li>
							<li>The headers are read for the server and network that sent it, and the sender's authentication (SPF, DKIM, DMARC) is checked against the brand it claims to be.</li>
							<li>The text and every link are analyzed for impersonation, credential or payment requests, and fake invoices or delivery notices.</li>
							<li>If it is phishing, the provider of the network it was sent from is sent an abuse report with the evidence, and every link is opened in an isolated browser and analyzed as its own case. Confirmed phishing sites are reported to their registrar, hosting provider, and takedown services.</li>
							<li>You get a reply with the verdict and a link to the public case page, where you can follow each report.</li>
						</ol>
					),
				},
				{
					heading: "3. Report it to your mail provider too",
					body: (
						<p>
							Use your mail app's own button (<strong>Report phishing</strong> in Gmail, <strong>Report → Report phishing</strong> in Outlook) after
							forwarding it. That teaches your provider's filter to catch the next copy before it reaches anyone else.
						</p>
					),
				},
				{
					heading: "Other places that accept phishing emails",
					body: (
						<ul>
							<li><a href="https://apwg.org/reportphishing" rel="noopener">APWG</a>: forward it to reportphishing@apwg.org; it feeds the data shared between security companies.</li>
							<li>United Kingdom: forward it to report@phishing.gov.uk, the NCSC's <a href="https://www.gov.uk/report-suspicious-emails-websites-phishing" rel="noopener">Suspicious Email Reporting Service</a>.</li>
							<li>United States: report fraud to the FTC at <a href="https://reportfraud.ftc.gov/" rel="noopener">ReportFraud.ftc.gov</a>.</li>
							<li>The company being impersonated: most banks and large brands list a phishing address on their security page.</li>
						</ul>
					),
				},
				{
					heading: "If you already clicked or replied",
					body: (
						<ul>
							<li>Entered a password: change it right away, on every site where you used it, and turn on two-factor sign-in.</li>
							<li>Entered card or bank details: call your bank on the number on your card and have the card blocked.</li>
							<li>Opened an attachment or ran something it asked for: disconnect the device and run a full malware scan before signing in anywhere.</li>
						</ul>
					),
				},
			]}
			questions={[
				{ question: "Is reporting a phishing email free?", answer: "Yes. Phishing Support is free and open source; it is run by Samuel Scheit and funded by donations." },
				{ question: "Is my email address published?", answer: "No. Your address and other personal details are removed before the email is stored. The case page shows the sender, the subject, the analysis, and the reports, so only forward emails you are allowed to share." },
				{ question: "How long does the analysis take?", answer: "Usually a few minutes. The case page updates live while the email and its links are analyzed, and you get a reply by email with the verdict." },
				{ question: "Should I forward the email or just delete it?", answer: "Forward it first, then delete it. A reported email gets the sending network and the phishing sites it links to reported, which protects the next people who receive it." },
			]}
		/>
	);
}
