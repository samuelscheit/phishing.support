import type { NextConfig } from "next";
import { SITE_URL } from "./src/lib/seo/site";

const nextConfig: NextConfig = {
	reactCompiler: true,
	serverExternalPackages: ["patchright", "rebrowser-puppeteer-core"],
	// browser-fabric (the browser task agent) ships TypeScript sources, not built JavaScript.
	transpilePackages: ["browser-fabric"],
	// Cloudflare's tunnel serves plain http too; every page has exactly one address, on https.
	async redirects() {
		return [{ source: "/:path*", has: [{ type: "header", key: "x-forwarded-proto", value: "http" }], destination: `${SITE_URL}/:path*`, permanent: true }];
	},
	async headers() {
		return [{ source: "/:path*", headers: [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] }];
	},
};

export default nextConfig;
