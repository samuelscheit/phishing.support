import type { NextConfig } from "next";
import { SITE_URL } from "./src/lib/seo/site";

const nextConfig: NextConfig = {
	reactCompiler: true,
	experimental: {
		// Next 16.4 bug (vercel/next.js#100251, #100267, #100735): once `next dev` restores Turbopack's
		// persisted cache, the root entry chunk list can be missing from its versioned content map.
		// Every HMR subscription is then answered with `restart`, which bumps the HMR version, and the
		// page reloads for "HMR hash mismatch" in an endless loop. Without the cache it can't happen;
		// this app compiles cold just as fast. Remove once a Next release fixes the restored cache.
		turbopackFileSystemCacheForDev: false,
	},
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
