import type { MetadataRoute } from "next";
import { absoluteUrl, SITE_URL } from "@/lib/seo/site";

export default function robots(): MetadataRoute.Robots {
	return {
		rules: {
			userAgent: "*",
			allow: "/",
			// The API answers machines, and an abuse report's tracking page is private to whoever holds its link.
			disallow: ["/api/", "/abuse-reporting/"],
		},
		sitemap: absoluteUrl("/sitemap.xml"),
		host: SITE_URL,
	};
}
