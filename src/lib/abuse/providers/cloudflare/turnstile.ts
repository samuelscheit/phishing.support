import { chromium, type Frame, type Request } from "patchright";

import { getChromeExecutablePath, getChromiumSandboxArgs } from "../../../browser/browser";
import { CLOUDFLARE_PROVIDER } from "./definition";
import { getProviderProxy, type ProviderProxy } from "../proxy";

const turnstileTimeoutMs = 120_000;
const blockedResourceTypes = new Set(["font", "image", "media"]);

export function shouldBlockCloudflareAsset(request: Pick<Request, "resourceType" | "url">): boolean {
	return blockedResourceTypes.has(request.resourceType()) || /\/favicon(?:\.ico)?(?:$|[?#])/i.test(request.url());
}

function isCloudflareChallengeUrl(url: string): boolean {
	return url.includes("challenges.cloudflare.com") || url.includes("/cdn-cgi/challenge-platform/") || url.includes("cf-challenge");
}

async function clickCloudflareChallengeCheckbox(frame: Frame): Promise<void> {
	try {
		await frame.locator('input[type="checkbox"]').first().click({ timeout: 10_000 });
	} catch {
		// Managed challenges do not always expose a checkbox. The form's
		// Turnstile response is the definitive ready signal.
	}
}

function rejectedFormError(response: { status(): number; headers(): Record<string, string> }): Error {
	const headers = response.headers();
	const details = [headers["cf-ray"] ? `Ray ID ${headers["cf-ray"]}` : undefined, headers["cf-mitigated"] ? `cf-mitigated=${headers["cf-mitigated"]}` : undefined]
		.filter((value): value is string => Boolean(value))
		.join(", ");
	return new Error(`Cloudflare abuse form load failed with HTTP ${response.status()}${details ? ` (${details})` : ""}.`);
}

/**
 * Open Cloudflare's reviewed phishing form after Turnstile has produced a
 * token. The caller owns browser closure after this point so form submission
 * and cleanup share one clear lifetime.
 */
export async function solveCloudflareAbuseTurnstile(proxy: ProviderProxy = getProviderProxy("Cloudflare abuse reporting")) {
	const executablePath = getChromeExecutablePath();
	const browser = await chromium.launch({
		...(executablePath ? { executablePath } : {}),
		headless: process.env.BROWSER_HEADLESS === "true",
		args: getChromiumSandboxArgs(),
		proxy: proxy.browser,
	});
	try {
		const context = await browser.newContext({
			ignoreHTTPSErrors: true,
			locale: "en-US",
			viewport: { width: 1920, height: 1080 },
		});

		await context.route("**/*", async (route) => {
			if (shouldBlockCloudflareAsset(route.request())) {
				await route.abort();
				return;
			}
			await route.continue();
		});

		const page = await context.newPage();
		page.on("framenavigated", (frame) => {
			if (isCloudflareChallengeUrl(frame.url())) void clickCloudflareChallengeCheckbox(frame);
		});

		const response = await page.goto(CLOUDFLARE_PROVIDER.formUrl, { waitUntil: "domcontentloaded", timeout: turnstileTimeoutMs });
		if (!response) throw new Error("Cloudflare abuse form navigation returned no response.");

		const managedChallenge = response.status() === 403 && response.headers()["cf-mitigated"] === "challenge";
		if (!response.ok() && !managedChallenge) throw rejectedFormError(response);

		const token = await page.waitForFunction(
			() => (document.querySelector('[name="cf-turnstile-response"]') as HTMLInputElement | null)?.value || false,
			undefined,
			{ timeout: turnstileTimeoutMs },
		);
		const turnstileToken = await token.jsonValue();
		if (typeof turnstileToken !== "string" || !turnstileToken) throw new Error("Cloudflare Turnstile did not produce a token.");

		return { page, browser };
	} catch (error) {
		await browser.close().catch(() => undefined);
		throw error;
	}
}
