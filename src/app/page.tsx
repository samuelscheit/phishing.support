import { SubmissionForm } from "@/components/SubmissionForm";
import { SubmissionsList } from "@/components/SubmissionsList";
import { SiteFooter, SiteHeader } from "@/components/SiteLayout";
import type { Metadata } from "next";
import About from "../components/About";
import Link from "next/link";
import { JsonLd } from "@/components/JsonLd";
import { absoluteUrl, SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/seo/site";

export const metadata: Metadata = {
	title: { absolute: "Phishing Support – Report phishing emails and websites for takedown" },
	description: SITE_DESCRIPTION,
	alternates: { canonical: "/" },
	openGraph: { url: "/", title: "Report phishing emails and websites for takedown", description: SITE_DESCRIPTION },
};

const ORGANIZATION_ID = `${SITE_URL}/#organization`;

/** Who runs the site and what it is, for search engines. */
const STRUCTURED_DATA = {
	"@context": "https://schema.org",
	"@graph": [
		{
			"@type": "WebSite",
			"@id": `${SITE_URL}/#website`,
			url: `${SITE_URL}/`,
			name: SITE_NAME,
			description: SITE_DESCRIPTION,
			inLanguage: "en",
			publisher: { "@id": ORGANIZATION_ID },
		},
		{
			"@type": "Organization",
			"@id": ORGANIZATION_ID,
			name: SITE_NAME,
			url: `${SITE_URL}/`,
			logo: absoluteUrl("/icon.svg"),
			email: "report@phishing.support",
			founder: {
				"@type": "Person",
				name: "Samuel Scheit",
				url: "https://samuelscheit.com",
				sameAs: ["https://github.com/samuelScheit", "https://x.com/SamuelScheit"],
			},
		},
		{
			"@type": "WebApplication",
			name: SITE_NAME,
			url: `${SITE_URL}/`,
			applicationCategory: "SecurityApplication",
			operatingSystem: "Any",
			description: SITE_DESCRIPTION,
			offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
			publisher: { "@id": ORGANIZATION_ID },
		},
	],
};

export default function Home() {
	return (
		<div className="">
			<JsonLd data={STRUCTURED_DATA} />
			<main className="container mx-auto px-4 space-y-10 min-h-[85vh] mb-10">
				<SiteHeader />
				<SubmissionForm />

				<div className="rounded-2xl border bg-muted/30 p-6">
					<h2 className="text-xl font-semibold">Need to report an abusive domain or server?</h2>
					<p className="mt-2 text-muted-foreground">Report abusive domains or IP addresses directly; reports go to the verified abuse contacts of each domain and network provider.</p>
					<Link href="/abuse-reporting" className="mt-4 inline-flex rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground hover:opacity-90">Open abuse reporting</Link>
				</div>

				<SubmissionsList />
			</main>

			<div className="container mx-auto px-4 max-w-2xl">
				<About />
			</div>

			<SiteFooter />
		</div>
	);
}
