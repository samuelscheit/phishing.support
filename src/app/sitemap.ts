import type { MetadataRoute } from "next";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import { CampaignRepository } from "@/lib/campaign/repository";
import { GUIDES } from "@/lib/seo/guides";
import { absoluteUrl } from "@/lib/seo/site";

export const dynamic = "force-dynamic";

/** The pages that explain the site; each is listed with the priority a crawler should give it. */
const STATIC_PAGES: Array<{ path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] }> = [
	{ path: "/", priority: 1, changeFrequency: "hourly" },
	...GUIDES.map(({ slug }) => ({ path: `/${slug}`, priority: 0.9, changeFrequency: "monthly" as const })),
	{ path: "/abuse-reporting", priority: 0.8, changeFrequency: "monthly" },
	{ path: "/info", priority: 0.5, changeFrequency: "monthly" },
	{ path: "/impressum", priority: 0.2, changeFrequency: "yearly" },
	{ path: "/datenschutz", priority: 0.2, changeFrequency: "yearly" },
];

/** One sitemap holds at most 50,000 URLs; the newest submissions fill what the static pages leave. */
const MAX_SITEMAP_URLS = 50_000;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
	const campaigns = await CampaignRepository.listCampaigns(1_000);
	const submissions = await SubmissionsEntity.listSitemapEntries(MAX_SITEMAP_URLS - STATIC_PAGES.length - campaigns.length);
	return [
		...STATIC_PAGES.map(({ path, priority, changeFrequency }) => ({ url: absoluteUrl(path), priority, changeFrequency })),
		...campaigns.map(({ campaign }) => ({
			url: absoluteUrl(`/campaigns/${campaign.id.toString()}`),
			lastModified: campaign.updatedAt,
			changeFrequency: "daily" as const,
			priority: 0.7,
		})),
		...submissions.map((submission) => ({
			url: absoluteUrl(`/submissions/${submission.id.toString()}`),
			lastModified: submission.updatedAt ?? submission.createdAt,
			changeFrequency: "weekly" as const,
			priority: 0.6,
		})),
	];
}
