import fs from "fs";
import { tmpdir } from "os";
import path from "path";
import { Browser, launch } from "rebrowser-puppeteer-core";
import { userAgent } from "../constants";

export async function getBrowser(use_puppeteer_core = false): Promise<Browser> {
	// TODO: harden puppeteer/browser for security

	const isDocker = process.env.DOCKER === "true" || process.env.PUPPETEER_NO_SANDBOX === "true";
	const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	// const chromePath = process.env.CHROME_PATH || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";

	const userDataDir = path.join(tmpdir(), "puppeteer-user-data");
	fs.mkdirSync(userDataDir, { recursive: true });
	console.log(`Created temporary user data directory at: ${userDataDir}`);

	const args: string[] = [
		`--screen-size=1920,1080`,
		"--disable-extensions",
		"--disable-file-system",
		"--disable-dev-shm-usage",
		"--disable-blink-features=AutomationControlled",
		"--disable-features=site-per-process",
		"--disable-advertisements",
		"--enable-javascript",
		"--disable-blink-features=AutomationControlled",
		"--disable-gpu",
		"--enable-webgl",
		`--user-agent=${userAgent}`,
	];

	// Chromium inside containers commonly requires disabling sandbox.
	if (isDocker) {
		args.push("--no-sandbox", "--disable-setuid-sandbox");
	}

	const options = {
		executablePath: chromePath,
		headless: false,
		// userDataDir,
		ignoreDefaultArgs: ["--enable-automation"],
		args,
		downloadBehavior: {
			policy: "deny",
		},
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
