import type { Metadata } from "next";

import { GuidePage } from "@/components/GuidePage";
import { SubmissionForm } from "@/components/SubmissionForm";
import { guideMetadata } from "@/lib/seo/guides";

export const metadata: Metadata = guideMetadata("report-phishing-website", "Report a phishing website for takedown");

export default function ReportPhishingWebsitePage() {
	return (
		<GuidePage
			slug="report-phishing-website"
			heading="Report a phishing website for takedown"
			lead="Paste the link of the phishing site below. It is captured in an isolated browser as evidence, and if it is phishing, it is reported to the companies that can take it offline: its domain registrar, its hosting provider, and takedown services."
			tool={<SubmissionForm defaultTab="url" />}
			sections={[
				{
					heading: "How the site is checked",
					body: (
						<ul>
							<li>The link is opened in an isolated browser, never on your device, and the page is saved with a screenshot and a timestamped evidence file.</li>
							<li>Phishing sites often hide from scanners: they show a harmless page to data centers, send desktops to a phone-only page, or put the login behind a fake “verify you are human” gate. The capture visits from residential and Tor networks, as a phone when the page asks for one, and clicks through such gates to reach the page that takes the data.</li>
							<li>The page is classified: does it impersonate a brand to collect passwords, codes, payment details, or a wallet's recovery phrase, or does it get visitors to download or run something harmful.</li>
						</ul>
					),
				},
				{
					heading: "Who receives the report",
					body: (
						<>
							<p>A confirmed site is reported to everyone who can take part of it down, each with the evidence:</p>
							<ul>
								<li><strong>The domain registrar</strong>, found from the domain's registration data (RDAP); it can suspend the domain everywhere at once.</li>
								<li><strong>The hosting provider and the network</strong> the site's server is on; they can remove the files or the server.</li>
								<li><strong>Cloudflare</strong>, when the site hides its real server behind it; it can disclose the real host and show a warning page.</li>
								<li><strong>Takedown and blocklist services</strong> such as Netcraft, whose lists browsers and security products use to warn visitors.</li>
							</ul>
							<p>When a provider answers, the reply is read and answered: a provider that says it found nothing is sent a fresh check of the site with steps to see the phishing page.</p>
						</>
					),
				},
				{
					heading: "Report it to browser blocklists too",
					body: (
						<p>
							Browsers warn visitors before a known phishing site loads. You can add the link yourself to{" "}
							<a href="https://safebrowsing.google.com/safebrowsing/report_phish/" rel="noopener">Google Safe Browsing</a> (Chrome, Firefox, Safari) and{" "}
							<a href="https://www.microsoft.com/en-us/wdsi/support/report-unsafe-site" rel="noopener">Microsoft SmartScreen</a> (Edge, Windows), and to{" "}
							<a href="https://report.netcraft.com/report" rel="noopener">Netcraft</a>.
						</p>
					),
				},
				{
					heading: "What makes a takedown fast",
					body: (
						<ul>
							<li><strong>The full link</strong>, path included: many phishing kits show their page only at the exact address that was sent out.</li>
							<li><strong>Report it soon</strong>: kits move to new domains within days, and a site that is gone cannot be proven any more.</li>
							<li><strong>Evidence a provider can check</strong>: a screenshot, the time, and how to reach the page. Each report here includes all three.</li>
						</ul>
					),
				},
			]}
			questions={[
				{ question: "Is it safe to paste a phishing link here?", answer: "Yes. The site is opened on our servers in an isolated browser, not on your device. Do not open the link yourself to check it." },
				{ question: "How long does a takedown take?", answer: "It depends on the provider: many registrars and hosts act within hours to a few days. The case page shows each report and every reply from the provider." },
				{ question: "What if the site shows nothing suspicious?", answer: "Some sites only show the phishing page to some visitors. If the capture could not reach the next step of the site, the case says it was inconclusive instead of calling the site safe, and it is checked again automatically." },
				{ question: "Can I report a site that copies my company's brand?", answer: "Yes. Submit its link here; the report goes to its registrar and host with the evidence. Brand owners often also have a trademark complaint route with the registrar." },
			]}
		/>
	);
}
