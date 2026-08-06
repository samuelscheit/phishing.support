import { runStreamedAnalysisRun } from "../analysis_run";
import { solveCloudflareTurnstile } from "../browser/solveCloudflareTurnstile";
import { abuseReplyMail, abuseReplyName, abuseReplyUrl, userAgent } from "../constants";
import { ReportsEntity } from "../db/entities";
import { defaultResponseModel } from "../utils";

export async function reportCloudflareAbuse(params: {
	url: string;
	explanation?: string;
	submissionId: bigint;
	analysisText: string;
	infringedBrand?: string;
	countryCode?: string;
}) {
	const { page, browser } = await solveCloudflareTurnstile({
		url: "https://abuse.cloudflare.com/phishing",
		noClose: true,
	});

	try {
		if (!params.explanation || !params.infringedBrand) {
			const { result } = await runStreamedAnalysisRun({
				submissionId: params.submissionId,
				options: {
					model: defaultResponseModel,
					input: [
						{
							role: "system",
							content: `You are an expert phishing analyst.
"body": Write a concise explanation of why the provided URL is considered a phishing website.
"infringed_brand": Write the legitimate brand being impersonated by the phishing website and, where known, its exact URL.`,
						},
						{
							role: "user",
							content: `Write the explanation based on this analysis:
${params.analysisText}

Phishing Website URL:
${params.url}`,
						},
					],
					text: {
						format: {
							type: "json_schema",
							name: "report_cloudflare_abuse",
							schema: {
								type: "object",
								properties: {
									body: { type: "string" },
									infringed_brand: { type: "string" },
								},
								required: ["body", "infringed_brand"],
								additionalProperties: false,
							},
							strict: true,
						},
						verbosity: "low",
					},
					tools: [{ type: "web_search" }],
					stream: true,
				},
			});
			if (!result.output_parsed) throw new Error("Failed to parse report draft response: " + result.output_text);

			params.explanation = result.output_parsed.body;
			params.infringedBrand = result.output_parsed.infringed_brand;
		}

		await page.locator('[name="name"]').fill(abuseReplyName);
		await page.locator('[name="email"]').fill(abuseReplyMail);
		await page.locator('[name="email2"]').fill(abuseReplyMail);
		await page.locator('[name="company"]').fill(abuseReplyUrl);
		await page.locator('[name="urls"]').fill(params.url);
		await page.locator('[name="justification"]').fill(`The URL ${params.url} is considered to be a phishing website.
More information can be found here: https://phishing.support/submissions/${params.submissionId}`);
		await page.locator('[name="original_work"]').fill(params.infringedBrand || "");
		await page.locator('[name="reported_country"]').evaluate((input, countryCode) => {
			const field = input as HTMLInputElement;
			field.value = countryCode || "DE";
			field.dispatchEvent(new Event("input", { bubbles: true }));
			field.dispatchEvent(new Event("change", { bubbles: true }));
		}, params.countryCode?.toUpperCase() || "DE");
		await page.locator('[name="reported_user_agent"]').fill(userAgent);
		await page.locator('[name="dsa_attestation"]').check();

		const dsaCertification = page.locator(
			`xpath=//span[starts-with(normalize-space(.),"DSA certification")]` +
				`/ancestor::*[self::div][1]` +
				`//following::input[@type="checkbox"][1]`,
		);
		if ((await dsaCertification.count()) === 0) throw new Error("Failed to find DSA certification checkbox");
		await dsaCertification.first().check();

		console.log("Submitting Cloudflare Abuse Report...");

		const responsePromise = page.waitForResponse((response) => response.url().includes("/api/v2/form/abuse_phishing"));
		await page.locator('button[type="submit"]').click();
		const response = await responsePromise;

		if (!response.ok()) {
			throw new Error(`Cloudflare abuse report submission failed: ${response.status()} ${await response.text()}`);
		}

		const json = await response.json();
		console.log("Cloudflare Abuse Report successfully submitted:", json);

		await ReportsEntity.create({
			submissionId: params.submissionId,
			to: "Cloudflare Abuse",
			body: `${params.explanation}\nInfringed Brand: ${params.infringedBrand!}`,
		});

		return json;
	} finally {
		await browser.close();
	}
}
