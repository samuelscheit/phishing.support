import { existsSync } from "node:fs";
import { launch, type Browser } from "rebrowser-puppeteer-core";

const chromeExecutableCandidates = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

export function getChromeExecutablePath() {
	if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
	return chromeExecutableCandidates.find((candidate) => existsSync(candidate));
}

export function getChromiumSandboxArgs() {
	const requiresNoSandbox = process.env.DOCKER === "true" || process.env.PUPPETEER_NO_SANDBOX === "true";
	return requiresNoSandbox ? ["--no-sandbox", "--disable-setuid-sandbox"] : [];
}

export async function getBrowser(use_puppeteer_core = false): Promise<Browser> {
	const executablePath = getChromeExecutablePath();

	const args: string[] = [
		`--screen-size=1920,1080`,
		"--disable-extensions",
		"--disable-file-system",
		"--disable-dev-shm-usage",
		"--disable-blink-features=AutomationControlled",
		"--disable-features=site-per-process",
		"--disable-advertisements",
		"--enable-javascript",
		"--disable-gpu",
		"--enable-webgl",
		...getChromiumSandboxArgs(),
	];

	const options = {
		...(executablePath ? { executablePath } : {}),
		headless: false,
		ignoreDefaultArgs: ["--enable-automation"],
		args,
		acceptInsecureCerts: true,
		dumpio: true,
	} as const;

	if (use_puppeteer_core) {
		const puppeteerCore = await import("puppeteer-core");
		// @ts-ignore
		return puppeteerCore.launch(options);
	}

	return launch(options as any);
}
