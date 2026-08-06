import type { MetadataRoute } from "next";
import { SubmissionsEntity } from "@/lib/db/entities";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
	const base = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

	const staticPaths = ["/", "/info"];

	const submissions = await SubmissionsEntity.list(1000);

	const urls: MetadataRoute.Sitemap = [];

	for (const p of staticPaths) {
		urls.push({ url: `${base}${p}`, lastModified: new Date() });
	}

	for (const s of submissions) {
		const id = s.id.toString();
		const lastModified = s.updatedAt ? new Date(s.updatedAt) : s.createdAt ? new Date(s.createdAt) : undefined;
		urls.push({ url: `${base}/submissions/${id}`, lastModified });
	}

	return urls;
}
