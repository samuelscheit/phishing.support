import Link from "next/link";
import type { ReactNode } from "react";

import { JsonLd } from "@/components/JsonLd";
import { SiteFooter } from "@/components/SiteLayout";
import { GUIDES, type GuideSlug } from "@/lib/seo/guides";
import { absoluteUrl, SITE_NAME, SITE_URL } from "@/lib/seo/site";

export type GuideSection = { heading: string; body: ReactNode };
export type GuideQuestion = { question: string; answer: string };

/** When the guide's text was last reviewed; shown on the page and to search engines. */
const REVIEWED = "2026-11-14";

/**
 * A guide: its heading and lead, the tool it is about, sections of how-to
 * text, frequently asked questions, and links to the other guides. Search
 * engines get it as an article in the site's breadcrumb, with its questions.
 */
export function GuidePage({ slug, heading, lead, tool, sections, questions }: {
	slug: GuideSlug;
	heading: string;
	lead: string;
	tool?: ReactNode;
	sections: GuideSection[];
	questions: GuideQuestion[];
}) {
	const url = absoluteUrl(`/${slug}`);
	const structuredData = {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "Article",
				"@id": `${url}#article`,
				headline: heading,
				description: lead,
				url,
				inLanguage: "en",
				dateModified: REVIEWED,
				author: { "@type": "Person", name: "Samuel Scheit", url: "https://samuelscheit.com" },
				publisher: { "@id": `${SITE_URL}/#organization` },
				isPartOf: { "@id": `${SITE_URL}/#website` },
			},
			{
				"@type": "BreadcrumbList",
				itemListElement: [
					{ "@type": "ListItem", position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
					{ "@type": "ListItem", position: 2, name: heading, item: url },
				],
			},
			{
				"@type": "FAQPage",
				mainEntity: questions.map(({ question, answer }) => ({ "@type": "Question", name: question, acceptedAnswer: { "@type": "Answer", text: answer } })),
			},
		],
	};

	return (
		<div>
			<JsonLd data={structuredData} />
			<header className="container mx-auto max-w-3xl px-4 pt-8">
				<nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
					<Link href="/" className="hover:text-foreground hover:underline">
						{SITE_NAME}
					</Link>
					<span aria-hidden className="px-2">/</span>
					<span className="text-foreground">{heading}</span>
				</nav>
			</header>

			<main className="container mx-auto max-w-3xl space-y-10 px-4 py-8">
				<div className="space-y-4">
					<h1 className="text-balance text-4xl font-bold tracking-tight">{heading}</h1>
					<p className="text-pretty text-lg text-muted-foreground">{lead}</p>
				</div>

				{tool}

				<article className="space-y-10 leading-7 [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_li]:mt-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-sm">
					{sections.map(({ heading: title, body }) => (
						<section key={title} className="space-y-3">
							<h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
							{body}
						</section>
					))}

					<section className="space-y-3">
						<h2 className="text-2xl font-semibold tracking-tight">Frequently asked questions</h2>
						<div className="divide-y rounded-xl border">
							{questions.map(({ question, answer }) => (
								<details key={question} className="group px-4 py-3 [&_summary::-webkit-details-marker]:hidden">
									<summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
										{question}
										<span aria-hidden className="text-muted-foreground transition-transform group-open:rotate-45">+</span>
									</summary>
									<p className="mt-2 text-muted-foreground">{answer}</p>
								</details>
							))}
						</div>
					</section>
				</article>

				<p className="text-sm text-muted-foreground">Last reviewed {REVIEWED} by Samuel Scheit, who runs {SITE_NAME}.</p>

				<nav aria-label="More guides" className="space-y-3 border-t pt-8">
					<h2 className="text-lg font-semibold">More guides</h2>
					<ul className="grid gap-3 sm:grid-cols-3">
						{GUIDES.filter((other) => other.slug !== slug).map((other) => (
							<li key={other.slug}>
								<Link href={`/${other.slug}`} className="block h-full rounded-xl border p-4 transition-colors hover:bg-accent">
									<span className="font-medium">{other.label}</span>
									<span className="mt-1 block text-sm text-muted-foreground">{other.description}</span>
								</Link>
							</li>
						))}
					</ul>
				</nav>
			</main>

			<SiteFooter />
		</div>
	);
}
