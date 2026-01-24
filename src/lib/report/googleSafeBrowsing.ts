// @ts-ignore
import anticaptcha from "@antiadmin/anticaptchaofficial";
import { generateReportDraft } from "./generateReportDraft";
import { sleep } from "../utils";
import { ReportsEntity } from "../db/entities";
import { generateAbuseExplanation } from "./util";
import { getBrowserPage } from "../browser";

export async function reportToGoogleSafeBrowsing(params: {
	url: string;
	explanation?: string;
	tries?: number;
	submissionId: bigint;
	analysisText: string;
}) {
	if (!params.tries) params.tries = 0;

	if (!params.explanation) {
		params.explanation = await generateAbuseExplanation({
			...params,
			to: "Google Safe Browsing",
		});
	}

	const { page, context, browser } = await getBrowserPage(undefined, "de");

	try {
		const report_url = `https://safebrowsing.google.com/safebrowsing/report_phish/?hl=de&url=${encodeURIComponent(params.url)}`;

		const { ANTICAPTCHA_API_KEY } = process.env;
		var token = undefined as string | undefined;

		if (ANTICAPTCHA_API_KEY) {
			anticaptcha.setAPIKey(ANTICAPTCHA_API_KEY || "");

			const uri = new URL(report_url);

			console.log("Solving reCAPTCHA v3 for Google Safe Browsing report page...");
			console.log(uri.origin + uri.pathname);

			token = await anticaptcha.solveRecaptchaV3(
				report_url,
				"6LdyJYcqAAAAAIkFpjuB7uz9WgDXmMECefi-8X-d",
				0.9, //minimum score required: 0.3, 0.7 or 0.9
				"submitUrl",
			);
			console.log("solved token:", token);

			// process.exit();

			await page.setRequestInterception(true);

			page.on("request", (req) => {
				const url = req.url();
				// Block specific URL
				if (
					(url.includes("https://www.google.com/recaptcha/api") || url.includes("https://www.gstatic.com/recaptcha/releases")) &&
					url.includes(".js")
				) {
					req.abort();
					console.log("Blocked:", url);
				} else {
					req.continue();
				}
			});
		}

		await page.goto(report_url, {
			waitUntil: "domcontentloaded",
		});

		if (token) {
			await page.evaluate((token) => {
				// Replacement for grecaptcha
				// @ts-ignore
				window.grecaptcha = {
					execute: function (sitekey: string, parameters: any) {
						console.log(`called execute function with sitekey ${sitekey} and parameters`, parameters);

						return new Promise((resolve) => resolve(token));
					},
					ready: function (callback: () => void) {
						callback();
					},
				};

				// @ts-ignore
				window.grecaptcha.enterprise = window.grecaptcha;
			}, token);
		}

		await page.waitForSelector(`#mat-input-0`);

		await page.type(`#mat-input-1`, params.explanation);

		await page.focus(`button[type="submit"]`);
		await sleep(Math.random() * 500 + 500);
		await page.keyboard.press("Enter");

		let card = await page.waitForSelector(`.form-status-card`);
		if (!card) throw new Error("Failed to find submission status card on Google Safe Browsing report page.");

		let hasSuccess = !!(await card.$(".success"));
		let hasFailure = !!(await card.$(".failure"));

		let text = await card.$eval("mat-card-content", (el) => el.textContent?.trim() || "");

		if (hasFailure) {
			console.warn("Google Safe Browsing report failed:", text);
			await sleep(3000); // wait before retrying
			// await page.click(`button[type="submit"]`);

			await page.focus(`button[type="submit"]`);
			await sleep(Math.random() * 500 + 500);
			await page.keyboard.press("Enter");
			await sleep(3000);

			card = await page.waitForSelector(`.form-status-card`);
			if (!card) throw new Error("Failed to find submission status card on Google Safe Browsing report page.");

			hasSuccess = !!(await card.$(".success"));
			hasFailure = !!(await card.$(".failure"));

			text = await card.$eval("mat-card-content", (el) => el.textContent?.trim() || "");

			console.log("Retry result:", text, { hasSuccess, hasFailure });

			if (hasFailure) {
				if (params.tries >= 0) {
					throw new Error("Google Safe Browsing report failed after multiple tries: " + text);
				}

				console.warn("Google Safe Browsing report failed, retrying...", text);
				await page.close();
				return reportToGoogleSafeBrowsing({ ...params, tries: params.tries + 1 });
			}
		}

		if (!hasSuccess) throw new Error("Google Safe Browsing report submission status unknown: " + card.evaluate((el) => el.outerHTML));

		const reportId = await ReportsEntity.create({
			submissionId: params.submissionId,
			to: `Google Safe Browsing`,
			body: params.explanation,
		});

		await browser.close();

		return {
			success: true,
			reportId: reportId,
			info: text,
		};
	} catch (err) {
		await browser.close();
		throw err;
	}
}

export async function reportToGoogleSafeBrowsingAPI(params: { url: string; projectNumber?: string }) {
	throw new Error("Not implemented.");
	// const projectNumber =
	// 	params.projectNumber ||
	// 	process.env.WEBRISK_PROJECT_NUMBER ||
	// 	process.env.GOOGLE_CLOUD_PROJECT_NUMBER ||
	// 	process.env.GOOGLE_CLOUD_PROJECT;

	// if (!projectNumber) {
	// 	throw new Error(
	// 		"Missing Google Cloud project number. Set WEBRISK_PROJECT_NUMBER or pass projectNumber to submitWebsiteToGoogleSafeBrowsingBlocklist()."
	// 	);
	// }

	// const auth = new GoogleAuth({
	// 	scopes: ["https://www.googleapis.com/auth/cloud-platform"],
	// });
	// const client = await auth.getClient();
	// const accessToken = await client.getAccessToken();
	// const token = typeof accessToken === "string" ? accessToken : accessToken?.token;

	// if (!token) {
	// 	throw new Error("Failed to acquire Google Cloud access token for Web Risk Submission API.");
	// }

	// const response = await fetch(`https://webrisk.googleapis.com/v1/projects/${projectNumber}/submissions`, {
	// 	method: "POST",
	// 	headers: {
	// 		Authorization: `Bearer ${token}`,
	// 		"Content-Type": "application/json",
	// 	},
	// 	body: JSON.stringify({
	// 		uri: params.url,
	// 	}),
	// });

	// if (!response.ok) {
	// 	const bodyText = await response.text();
	// 	throw new Error(`Web Risk submission failed (${response.status} ${response.statusText}): ${bodyText}`);
	// }

	// return (await response.json()) as { uri: string; threatTypes?: string[] };
}
