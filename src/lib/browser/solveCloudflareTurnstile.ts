import { chromium, type Frame, type Request } from "patchright";
import { getReportProxy } from "../report/proxy";
import { getChromeExecutablePath, getChromiumSandboxArgs } from "./browser";

const blockedResourceTypes = new Set(["font", "image", "media"]);

export function shouldBlockCloudflareAsset(request: Pick<Request, "resourceType" | "url">) {
	return blockedResourceTypes.has(request.resourceType()) || /\/favicon(?:\.ico)?(?:$|[?#])/i.test(request.url());
}

function isCloudflareChallengeUrl(url: string) {
	return url.includes("challenges.cloudflare.com") || url.includes("/cdn-cgi/challenge-platform/") || url.includes("cf-challenge");
}

async function clickCloudflareChallengeCheckbox(frame: Frame) {
	try {
		const checkbox = frame.locator('input[type="checkbox"]').first();
		await checkbox.click({ timeout: 10_000 });
	} catch {
		// A managed challenge does not always expose a checkbox. The form's Turnstile token is the definitive signal.
	}
}

function rejectedFormError(response: { status(): number; headers(): Record<string, string> }) {
	const headers = response.headers();
	const rayId = headers["cf-ray"];
	const mitigated = headers["cf-mitigated"];
	const details = [rayId ? `Ray ID ${rayId}` : undefined, mitigated ? `cf-mitigated=${mitigated}` : undefined]
		.filter(Boolean)
		.join(", ");

	return new Error(`Cloudflare abuse form load failed with HTTP ${response.status()}${details ? ` (${details})` : ""}.`);
}

export async function solveCloudflareTurnstile(params: { url: string; timeout?: number; noClose?: boolean }) {
	const timeout = params.timeout ?? 120_000;
	const proxy = getReportProxy("Cloudflare abuse reporting");
	const executablePath = getChromeExecutablePath();
	const browser = await chromium.launch({
		...(executablePath ? { executablePath } : {}),
		headless: process.env.BROWSER_HEADLESS === "true",
		args: getChromiumSandboxArgs(),
		proxy: proxy.browser,
	});
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
		if (isCloudflareChallengeUrl(frame.url())) {
			void clickCloudflareChallengeCheckbox(frame);
		}
	});

	try {
		const response = await page.goto(params.url, { waitUntil: "domcontentloaded", timeout });
		if (!response) throw new Error("Cloudflare abuse form navigation returned no response.");

		const isManagedChallenge = response.status() === 403 && response.headers()["cf-mitigated"] === "challenge";
		if (!response.ok() && !isManagedChallenge) throw rejectedFormError(response);

		const token = await page.waitForFunction(
			() => {
				const input = document.querySelector('[name="cf-turnstile-response"]') as HTMLInputElement | null;
				return input?.value || false;
			},
			undefined,
			{ timeout },
		);
		const turnstileToken = await token.jsonValue();
		if (typeof turnstileToken !== "string" || !turnstileToken) {
			throw new Error("Cloudflare Turnstile did not produce a token.");
		}

		const cookies = await context.cookies(params.url);
		if (!params.noClose) await browser.close();

		return {
			token: turnstileToken,
			cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
			page,
			context,
			browser,
		};
	} catch (error) {
		await browser.close();
		throw error;
	}
}
