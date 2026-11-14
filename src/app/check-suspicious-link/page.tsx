import type { Metadata } from "next";

import { GuidePage } from "@/components/GuidePage";
import { RecentPhishingSites } from "@/components/RecentPhishingSites";
import { SubmissionForm } from "@/components/SubmissionForm";
import { guideMetadata } from "@/lib/seo/guides";

export const metadata: Metadata = guideMetadata("check-suspicious-link", "Is this link safe? How to check a suspicious link");

// The examples are the newest confirmed phishing sites.
export const dynamic = "force-dynamic";

export default function CheckSuspiciousLinkPage() {
	return (
		<GuidePage
			slug="check-suspicious-link"
			heading="Is this link safe? How to check a suspicious link"
			lead="Don't open a link you are unsure about. Paste it below instead: it is opened in an isolated browser and you get a verdict, with a screenshot of what the page really shows. Below are the signs to look for yourself."
			tool={<SubmissionForm defaultTab="url" />}
			sections={[
				{
					heading: "Signs a link is a phishing site",
					body: (
						<ul>
							<li>
								<strong>The brand is not the domain.</strong> Read the address from the right: in <code>docusign.alt3-doc3ea7-v2.sbs</code> the domain is{" "}
								<code>alt3-doc3ea7-v2.sbs</code>, not DocuSign. A brand name at the start, in a subdomain or in the path proves nothing.
							</li>
							<li><strong>Lookalike spelling.</strong> Swapped or added letters (<code>rn</code> for <code>m</code>, <code>paypa1</code>), extra words (<code>-secure</code>, <code>-login</code>, <code>-verify</code>), or an unusual ending such as <code>.sbs</code>, <code>.icu</code> or <code>.top</code>.</li>
							<li><strong>A shortened or tracking link</strong> hides where it goes. Phishing campaigns often send visitors through several redirects so each link in an email looks different.</li>
							<li><strong>A very new domain.</strong> Most phishing domains are days or weeks old; the registration date in the domain's WHOIS record shows it.</li>
							<li><strong>A “verify you are human” page</strong> that is not on the company's own domain, especially one that asks you to press keys or paste a command: that is how fake captchas install malware.</li>
							<li><strong>Pressure.</strong> An account about to close, a parcel waiting, an invoice overdue, a password expiring today: urgency is there so you don't check the address.</li>
						</ul>
					),
				},
				{
					heading: "How to check a link without opening it",
					body: (
						<ol>
							<li>On a computer, hover over the link and read the real address in the bottom corner; on a phone, press and hold it.</li>
							<li>Paste the address into the form above. The page is opened in an isolated browser and classified, and the case page shows what it showed and where it redirected.</li>
							<li>If you need the site, type the company's address yourself or use its app instead of the link.</li>
						</ol>
					),
				},
				{
					heading: "Recently confirmed phishing sites",
					body: (
						<>
							<p>Real phishing sites submitted here and confirmed in the last days, each with its evidence and reports:</p>
							<RecentPhishingSites />
						</>
					),
				},
			]}
			questions={[
				{ question: "Is it safe to check a link here?", answer: "Yes. The link is opened on our servers in an isolated browser, not on your device, and nothing is sent to the site from you." },
				{ question: "What if I already opened the link?", answer: "Opening a phishing page alone rarely harms you. If you entered a password, change it everywhere you used it and turn on two-factor sign-in; if you entered card details, call your bank; if you downloaded or ran something, disconnect the device and scan it for malware." },
				{ question: "Is a site with a padlock (https) safe?", answer: "No. The padlock only means the connection is encrypted. Almost every phishing site has one, because certificates are free and issued automatically." },
				{ question: "Are the results public?", answer: "Yes. Every checked link gets a public case page with the verdict, so others searching for the same site can find it." },
			]}
		/>
	);
}
