import sharp from "sharp";
import type { Route } from "patchright";

import type { CapturedGnameEvidence } from "./evidence";
import { acquireFabricPatchrightSession } from "../../../browser/fabric";
import { assertPublicDnsHost, domainMatchesOrIsSubdomain } from "../../security";
import { publicGnameEvidenceHost } from "./url_policy";

/**
 * Capture a target in a Fabric-owned disposable browser lease. Every requested
 * hostname is DNS-checked before navigation; redirects to a different target
 * domain are recorded but never treated as evidence for the submitted domain.
 */
export async function captureFreshGnameEvidence(url: string): Promise<CapturedGnameEvidence> {
	const targetHost = publicGnameEvidenceHost(url);
	await assertPublicDnsHost(targetHost);
	const session = await acquireFabricPatchrightSession(
		{ operation: "gname-evidence-capture" },
		{ leaseMode: "clone" },
	);
	const context = session.context;
	try {
		const page = context.pages()[0] ?? (await context.newPage());
		await page.setViewportSize({ width: 1440, height: 1000 });
		await context.route("**/*", async (route: Route) => {
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
		const finalHost = publicGnameEvidenceHost(finalUrl);
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
		await session.release();
	}
}
