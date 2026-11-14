import type { Metadata } from "next";

/** The guide pages: each answers one thing people search for, with the tool that does it. */
export const GUIDES = [
	{
		slug: "report-phishing-email",
		label: "Report a phishing email",
		description: "Forward a phishing email to report@phishing.support or upload it: the sender's providers and every phishing link in it are reported for takedown.",
	},
	{
		slug: "report-phishing-website",
		label: "Report a phishing website",
		description: "Paste the link of a phishing site: it is captured as evidence and reported to its registrar, its hosting provider, and takedown services.",
	},
	{
		slug: "check-suspicious-link",
		label: "Check a suspicious link",
		description: "How to tell whether a link is a phishing site, the signs to look for, and how to check one safely without opening it yourself.",
	},
	{
		slug: "report-ip-abuse",
		label: "Report IP address or domain abuse",
		description: "Find the abuse contact behind an IP address or domain and report spam, attacks, or phishing to the network provider and registrar that can stop it.",
	},
] as const;

export type GuideSlug = (typeof GUIDES)[number]["slug"];

function guide(slug: GuideSlug) {
	return GUIDES.find((candidate) => candidate.slug === slug)!;
}

/** A guide's page metadata: its search title, its description, and its one canonical address. */
export function guideMetadata(slug: GuideSlug, title: string): Metadata {
	const { description } = guide(slug);
	return {
		title,
		description,
		alternates: { canonical: `/${slug}` },
		openGraph: { type: "article", url: `/${slug}`, title, description },
	};
}
