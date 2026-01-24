import { writeFileSync } from "fs";
import { runStreamedAnalysisRun } from "../analysis_run";
import { ReportsEntity } from "../db/entities";
import { parse } from "tldts";
import { join } from "path";
import { tmpdir } from "os";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpClient } from "./deathbycaptcha";
import { getBrowserPage } from "../browser";

// const dbc = require("./deathbycaptcha");

const dbcClient = new HttpClient(process.env.DEATHBYCAPTCHA_USERNAME!, process.env.DEATHBYCAPTCHA_PASSWORD!);

export async function reportTencentCloudAbuse(params: {
	url: string;
	explanation?: string;
	submissionId: bigint;
	analysisText: string;
	websiteScreenshot: Buffer;
	infringedUrl?: string;
}) {
	if (!params.explanation || !params.infringedUrl) {
		const { result } = await runStreamedAnalysisRun({
			submissionId: params.submissionId,
			options: {
				model: "gpt-5.2",
				input: [
					{
						role: "system",
						content: `You are an expert phishing analyst. Write a very concise explanation (max 400 chars) for reporting a phishing website to Tencent Cloud Domain Abuse platform. 
The explanation must clearly state only the most important point why the website is a phishing site.

Write very short to them if they need further information about this case, they can find it at https://phishing.support/submissions/${params.submissionId}
Research the impersonated brand website URL address ("infringed_url") using web_search.`,
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
						name: "report_tencent_cloud_abuse",
						schema: {
							type: "object",
							properties: {
								body: { type: "string" },
								infringed_url: { type: "string" },
							},
							required: ["body"],
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

		params.explanation = result.output_parsed.body.slice(0, 500);
		params.infringedUrl = result.output_parsed.infringed_url;
	}

	const domain = parse(params.url);
	if (!domain.domain) throw new Error("Invalid domain parsed from URL");

	const fileBase64 = Buffer.from(params.websiteScreenshot).toString("base64");

	// Proxy and tencent token data
	const tencent_params = JSON.stringify({
		proxy: process.env.PROXY_URL,
		proxytype: "HTTP",
		appid: "2070586963",
		pageurl: "https://www.tencentcloud.com/report-platform/dnsabuse",
	});

	const captcha = await new Promise<string>((resolve, reject) => {
		dbcClient.decode({ extra: { type: 23, tencent_params: tencent_params } }, (captcha: any) => {
			if (captcha === null) {
				reject("Failed to solve CAPTCHA");
				return;
			}
			if (captcha) {
				try {
					console.log("Captcha " + captcha["captcha"] + " solved: " + captcha["text"]);
					const data = JSON.parse(captcha["text"]);
					if (data.ret !== 0 || !data.ticket) throw new Error("Captcha solving failed: " + captcha["text"]);

					/*
					 * Report an incorrectly solved CAPTCHA.
					 * Make sure the CAPTCHA was in fact incorrectly solved!
					 * client.report(captcha['captcha'], (result) => {
					 *   console.log('Report status: ' + result);
					 * });
					 */
					console.log(captcha);
					// {
					// 	"appid": "2070586963",
					// 	"ret": 0,
					// 	"ticket": "tr03uMCC_XpIhS16E29rzPECJgRcHfw02dEURoUOF_x0RvQYYvBNjqnu0GcY9p7Onh7IqRF1N5Ea-oeVL7X8Mok8B2xxzl4yrSE01762OhOfZt6PCgRCapqVY4ANnPyLC19LURql3TZGHj8C1p29USJo1GHJSbt1RRhxGr-itbqH7_WSu_68uIVtgNL71-cG7IYN",
					// 	"randstr": "@zFw"
					// }

					resolve(data);
				} catch (err) {
					reject(err);
				}
			}
		});
	});

	const response = await fetch("https://www.tencentcloud.com/main/ajax/reportDsaPlatform/createDomainReport", {
		headers: {
			accept: "application/json, text/plain, */*",
			"accept-language": "en-US,en;q=0.9",
			"content-type": "application/json",
			priority: "u=1, i",
			"sec-ch-ua": '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
			"sec-ch-ua-mobile": "?0",
			"sec-ch-ua-platform": '"macOS"',
			"sec-fetch-dest": "empty",
			"sec-fetch-mode": "cors",
			"sec-fetch-site": "same-origin",
			cookie: "intl_language=en; language=en",
			Referer: "https://www.tencentcloud.com/report-platform/dnsabuse",
		},
		body: JSON.stringify({
			action: "createDomainReport",
			payload: {
				captcha,
				formData: {
					domain: domain.domain,
					url: params.url,
					describe: params.explanation,
					infringedUrl: params.infringedUrl,
					category: ["Phishing"],
					name: "Phishing Support",
					email: "support@phishing.support",
					privacyCheckbox1: true,
					privacyCheckbox2: true,
					country_code: "DE",
					country_name: "Germany",
					fileBase64,
					filename: `tencent_report_${Date.now()}.png`,
				},
			},
		}),
		method: "POST",
		// @ts-ignore
		agent: new HttpProxyAgent(process.env.PROXY_URL),
		proxy: process.env.PROXY_URL,
	});

	const json = await response.json();
	console.log(json);
	const { code, msg, data } = json as {
		code: number;
		msg: string;
		data: { code: string; error: string; message: string; details: any[] };
	};

	if (code !== 0 || data.code !== "0") {
		throw new Error(`Failed to submit Tencent Cloud Abuse report: ${msg} / ${data.error} / ${data.message}`);
	}

	await ReportsEntity.create({
		submissionId: params.submissionId,
		to: `Tencent Cloud Domain Abuse`,
		body: `${params.explanation}\nInfringed URL: ${params.infringedUrl}`,
	});
}

async function reportToTencentCloudAbuseBrowser(params: {
	url: string;
	explanation: string;
	submissionId: bigint;
	tries?: number;
	analysisText: string;
	infringedUrl?: string;
	websiteScreenshot: Buffer;
}) {
	const { context, page, browser } = await getBrowserPage();

	const domain = parse(params.url);
	if (!domain.domain) throw new Error("Invalid domain parsed from URL");

	try {
		const report_url = `https://www.tencentcloud.com/report-platform/dnsabuse?lang=en`;

		await page.goto(report_url);

		await page.waitForSelector(`[name="domain"]`);
		await page.type(`[name="domain"]`, domain.domain);
		await page.type(`[name="url"]`, params.url);
		await page.type(`[name="describe"]`, params.explanation);
		await page.type(`[name="infringedUrl"]`, params.infringedUrl!);

		async function setSelectValue(labelText: string, value: string) {
			const category = await page.$(`xpath=//div[@class="report-dsa-form-style"]/div//label[normalize-space(.)="${labelText}"]`);
			if (!category) throw new Error("Category element not found");

			const parent = await page.evaluateHandle((el) => el.parentElement!, category);
			if (!parent) throw new Error("Category sibling element not found");

			const select = await parent.$(".form-item-select");
			if (!select) throw new Error("Category select element not found");
			await select.click();

			try {
				const checkbox = await page.locator(`[name="${value}"]`).setTimeout(200).waitHandle({});
				if (!checkbox) throw new Error("Phishing checkbox not found");
				checkbox.click();
			} catch (err) {
				// const dropdownMenu = await parent.$(`.dropdown-menu .info ::-p-text(${value})`);
				const dropdownMenu = await parent.$(`xpath=//span[normalize-space(.)="${value}"]`);
				if (!dropdownMenu) throw new Error("Dropdown menu item not found: " + value);
				await dropdownMenu.click();
			}
		}

		await setSelectValue("* Category", "Phishing");

		const filePicker = page.waitForFileChooser();

		// const formFile = await page.locator(`.form-upload.dns-upload-container div.form-file`).waitHandle();

		// console.log(await formFile.evaluate((el) => el.outerHTML));
		await page.click(`.form-upload.dns-upload-container div.form-file`);

		const tempFilePath = join(tmpdir(), `tencent_report_${Date.now()}.png`);

		writeFileSync(tempFilePath, params.websiteScreenshot);

		(await filePicker).accept([tempFilePath]);

		await page.type(`[name="name"]`, "Phishing Support");
		await page.type(`[name="email"]`, "support@phishing.support");

		await setSelectValue("* Country/Region", "Germany");

		const submit = await page.$(`[report-event="click_report_platform_submit"]`);
		if (!submit) throw new Error("Submit button not found");
		await submit.scrollIntoView();

		await page.click(`[name="privacyCheckbox1"]`);
		await page.click(`[name="privacyCheckbox2"]`);
		await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

		// await submit.click();
		// 2070586963

		// const reportId = await ReportsEntity.create({
		// 	submissionId: params.submissionId,
		// 	to: `Google Safe Browsing`,
		// 	body: params.explanation,
		// });

		await browser.close();
	} catch (err) {
		await browser.close();
		throw err;
	}
}
