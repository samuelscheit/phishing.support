import type { Metadata } from "next";
import Link from "next/link";

import { GuidePage } from "@/components/GuidePage";
import { guideMetadata } from "@/lib/seo/guides";

export const metadata: Metadata = guideMetadata("report-ip-abuse", "How to report IP address and domain abuse");

export default function ReportIpAbusePage() {
	return (
		<GuidePage
			slug="report-ip-abuse"
			heading="How to report IP address and domain abuse"
			lead="Every IP address belongs to a network provider and every domain to a registrar, and each publishes an abuse contact. Reporting abuse means finding that contact and sending evidence it can act on. The abuse reporting form does both for you."
			tool={
				<div className="rounded-xl border bg-muted/30 p-6">
					<h2 className="text-xl font-semibold">Report an abusive IP address or domain</h2>
					<p className="mt-2 text-muted-foreground">Enter the IP address or domain and what it did. The form finds the verified abuse contacts of its network provider and registrar and sends each of them your report.</p>
					<Link href="/abuse-reporting" className="mt-4 inline-flex rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground hover:opacity-90">
						Open the abuse reporting form
					</Link>
				</div>
			}
			sections={[
				{
					heading: "Who handles abuse from an IP address",
					body: (
						<>
							<p>
								An IP address is assigned to a network: a hosting company, a cloud provider, or an internet provider. Its registration record at the regional
								internet registry (ARIN, RIPE NCC, APNIC, LACNIC, or AFRINIC) names an abuse contact, usually an address like <code>abuse@provider.com</code>.
								You can look it up with an RDAP or WHOIS query for the address.
							</p>
							<p>That provider can warn its customer, block the traffic, or shut the server down. It is the right place for spam, scanning, brute-force logins, attacks, and phishing pages on a server.</p>
						</>
					),
				},
				{
					heading: "Who handles abuse from a domain",
					body: (
						<p>
							A domain's registrar can suspend it, which takes down every site and mailbox on it at once. Registrars accredited by ICANN must publish an abuse
							contact and act on reports; the domain's RDAP record names the registrar and its contact. Use it for phishing, malware, and fraud domains. For a
							site's content, also report to its hosting provider, found from the IP address the domain points to.
						</p>
					),
				},
				{
					heading: "What to put in an abuse report",
					body: (
						<ul>
							<li>The exact IP address or domain, and the full URL for a website.</li>
							<li>What happened, and when, with the time zone: providers match it against their logs.</li>
							<li>The evidence: log lines, email headers, or a screenshot. Paste text rather than attaching files where you can; many abuse mailboxes reject attachments.</li>
							<li>One report per incident, in plain language. Abuse desks get thousands a day; a short report with checkable evidence is the one that is acted on.</li>
						</ul>
					),
				},
				{
					heading: "Phishing emails and websites",
					body: (
						<p>
							For phishing, you don't need to find any contact yourself: <Link href="/report-phishing-email">forward the phishing email</Link> or{" "}
							<Link href="/report-phishing-website">submit the phishing site</Link>, and the sending network, the site's registrar and host, and takedown services
							are reported with the captured evidence.
						</p>
					),
				},
			]}
			questions={[
				{ question: "Can I report an IP address anonymously?", answer: "Abuse desks need a way to ask follow-up questions, so reports are sent from Phishing Support with the evidence; the provider replies there, and you can follow the report on its tracking page." },
				{ question: "What if the abuse contact does not respond?", answer: "Many providers act without replying. If the abuse continues, report it again with new evidence; for domains, ICANN accepts complaints about registrars that ignore abuse reports." },
				{ question: "Can I report an IP address to the police?", answer: "For crimes against you, such as fraud or extortion, report to the police or your national cybercrime reporting service. The network provider can still stop the server while the police investigate." },
			]}
		/>
	);
}
