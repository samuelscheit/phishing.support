import { getBrowserPage } from "./page";

export async function solveCloudflareTurnstile(params: { url: string; proxy_country_code?: string; timeout?: number; noClose?: boolean }) {
	const { context, page, browser } = await getBrowserPage(undefined, params.proxy_country_code);

	try {
		await page.goto(params.url, { waitUntil: "domcontentloaded" });

		// const input = await page.waitForSelector('[name="cf-turnstile-response"]', { timeout: params.timeout ?? 120 * 1000 });

		const token = await page.evaluate(
			() =>
				new Promise<string>((resolve) => {
					setInterval(() => {
						const input = document.querySelector('[name="cf-turnstile-response"]');
						if (!input) return;
						const value = (input as HTMLInputElement).value;
						if (value && value.length > 0) {
							console.log("Detected Cloudflare Turnstile token:", value);
							resolve(value);
						}
					}, 50);
				}),
		);

		const cookies = await context.cookies();

		if (params.noClose !== true) {
			await browser.close();
		}

		const uri = new URL(params.url);

		return {
			token,
			cookie: cookies
				.filter((x) => x.domain.includes(uri.hostname))
				.map((x) => `${x.name}=${x.value}`)
				.join("; "),
			page,
			context,
			browser,
		};
	} catch (error) {
		await browser.close();
		throw error;
	}
}
