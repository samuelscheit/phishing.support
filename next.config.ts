import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	/* config options here */
	reactCompiler: true,
	serverExternalPackages: ["patchright", "puppeteer-real-browser", "rebrowser-puppeteer-core"],
};

export default nextConfig;
