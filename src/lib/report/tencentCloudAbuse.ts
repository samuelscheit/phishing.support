import { fetch as proxyFetch } from "netbun";
import { parse } from "tldts";
import { runStreamedAnalysisRun } from "../analysis_run";
import { ReportsEntity } from "../db/entities";
import { defaultResponseModel } from "../utils";
import { getReportProxy } from "./proxy";

type TencentCaptcha = {
	ret: number;
	ticket?: string;
	[key: string]: unknown;
};

export async function reportTencentCloudAbuse(params: {
	url: string;
	explanation?: string;
	submissionId: bigint;
	analysisText: string;
	websiteScreenshot: Buffer;
	infringedUrl?: string;
}) {
	const { HttpClient } = await import("./deathbycaptcha");
	const dbcClient = new HttpClient(process.env.DEATHBYCAPTCHA_USERNAME!, process.env.DEATHBYCAPTCHA_PASSWORD!);
	const proxy = getReportProxy("Tencent Cloud abuse reporting");

	if (!params.explanation || !params.infringedUrl) {
		const { result } = await runStreamedAnalysisRun({
			submissionId: params.submissionId,
			options: {
				model: defaultResponseModel,
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

	const tencentParams = JSON.stringify({
		proxy: proxy.url,
		proxytype: proxy.captchaType,
		appid: "2070586963",
		pageurl: "https://www.tencentcloud.com/report-platform/dnsabuse",
	});

	const captcha = await new Promise<TencentCaptcha>((resolve, reject) => {
		dbcClient.decode({ extra: { type: 23, tencent_params: tencentParams } }, (result: any) => {
			if (result === null) {
				reject(new Error("Failed to solve Tencent CAPTCHA."));
				return;
			}
			if (!result) return;

			try {
				const data = JSON.parse(result.text) as TencentCaptcha;
				if (data.ret !== 0 || !data.ticket) throw new Error("Tencent CAPTCHA solving failed.");
				resolve(data);
			} catch (error) {
				reject(error);
			}
		});
	});

	const response = await proxyFetch("https://www.tencentcloud.com/main/ajax/reportDsaPlatform/createDomainReport", {
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
					fileBase64: params.websiteScreenshot.toString("base64"),
					filename: `tencent_report_${Date.now()}.png`,
				},
			},
		}),
		method: "POST",
		proxy: proxy.url,
	});

	const json = (await response.json()) as {
		code: number;
		msg: string;
		data?: { code?: string; error?: string; message?: string };
	};
	if (json.code !== 0 || json.data?.code !== "0") {
		throw new Error(`Failed to submit Tencent Cloud Abuse report: ${json.msg} / ${json.data?.error} / ${json.data?.message}`);
	}

	await ReportsEntity.create({
		submissionId: params.submissionId,
		to: "Tencent Cloud Domain Abuse",
		body: `${params.explanation}\nInfringed URL: ${params.infringedUrl}`,
	});

	return json;
}
