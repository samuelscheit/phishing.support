import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { chromium } from "patchright";
import sharp from "sharp";

import type { CapturedEvidence } from "../evidence";
import { assertPublicDnsHost, domainMatchesOrIsSubdomain } from "../security";
import { publicEvidenceHost } from "./url_policy";

/**
 * Capture a target in a fresh, throw-away Patchright profile. Every requested
 * hostname is DNS-checked before navigation; redirects to a different target
 * domain are recorded but never treated as evidence for the submitted domain.
 */
export async function captureFreshAbuseEvidence(url: string): Promise<CapturedEvidence> {
	const targetHost = publicEvidenceHost(url);
	await assertPublicDnsHost(targetHost);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "abuse-browser-"));
	const executablePath = process.env.CHROME_PATH;
	const context = await chromium.launchPersistentContext(profile, {
		...(executablePath ? { executablePath } : {}),
		headless: true,
		viewport: { width: 1440, height: 1000 },
		args: ["--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check"],
	});
	try {
		const page = context.pages()[0] ?? (await context.newPage());
		await context.route("**/*", async (route) => {
			try {
				const requestUrl = new URL(route.request().url());
				if (!["http:", "https:"].includes(requestUrl.protocol)) {
					await route.abort();
					return;
				}
				await assertPublicDnsHost(requestUrl.hostname);
				await route.continue();
			} catch {
				await route.abort();
			}
		});
		await page.goto(url, { waitUntil: "networkidle", timeout: 120_000 });
		const finalUrl = page.url();
		const finalHost = publicEvidenceHost(finalUrl);
		const screenshot = Buffer.from(await page.screenshot({ type: "png", fullPage: true }));
		const jpeg = await sharp(screenshot).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
		const pageTitle = (await page.title()).slice(0, 1_000);
		const pageText = (await page.locator("body").innerText().catch(() => "")).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 20_000);
		const associated = domainMatchesOrIsSubdomain(finalHost, targetHost);
		return {
			url: finalUrl,
			screenshot: jpeg,
			mimeType: "image/jpeg",
			capturedAt: new Date(),
			pageText,
			pageTitle,
			metadata: {
				initialUrl: url,
				initialHost: targetHost,
				finalHost,
				associated,
				pageTextLength: pageText.length,
			},
		};
	} finally {
		await context.close();
		await fs.rm(profile, { recursive: true, force: true });
	}
}
