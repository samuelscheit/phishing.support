import { runStreamedAnalysisRun } from "../analysis_run";
import { solveCloudflareTurnstile } from "../browser/solveCloudflareTurnstile";
import { abuseReplyMail, abuseReplyName, abuseReplyUrl, userAgent } from "../constants";
import { ReportsEntity } from "../db/entities";

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
		proxy_country_code: params.countryCode,
	});

	try {
		if (!params.explanation || !params.infringedBrand) {
			const { result } = await runStreamedAnalysisRun({
				submissionId: params.submissionId,
				options: {
					model: "gpt-5.2",
					input: [
						{
							role: "system",
							content: `You are an expert phishing analyst. 
"body": Write a concise explanation of why the provided URL is considered a phishing website.
"infringed_brand": Wite the legitimate brand being impersonated by the phishing website and possibly the exact URL address of the cloned website.
					`,
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

		await page.waitForSelector(`[name="name"]`);
		await page.type(`[name="name"]`, abuseReplyName);
		await page.type(`[name="email"]`, abuseReplyMail);
		await page.type(`[name="email2"]`, abuseReplyMail);
		await page.type(`[name="company"]`, abuseReplyUrl);
		await page.type(`[name="urls"]`, `${params.url}`);
		await page.type(
			`[name="justification"]`,
			`The URL ${params.url} is considered to be a phishing website.
More information can be found here: https://phishing.support/submissions/${params.submissionId}`,
		);
		await page.type(`[name="original_work"]`, params.infringedBrand || "");
		await page.evaluate((countryCode: string) => {
			const input = document.querySelector(`[name="reported_country"]`) as HTMLInputElement;
			if (!input) throw new Error("Failed to find reported_country input");
			input.value = countryCode?.toUpperCase() ?? "DE";
		}, params.countryCode || "");

		await page.type(`[name="reported_user_agent"]`, userAgent);
		await page.click(`[name="dsa_attestation"]`);

		const checkbox = await page.$(
			`xpath=//span[starts-with(normalize-space(.),"DSA certification")]` +
				`/ancestor::*[self::div][1]` +
				`//following::input[@type="checkbox"][1]`,
		);
		if (!checkbox) throw new Error("Failed to find DSA certification checkbox");

		await checkbox.click();

		console.log("Submitting Cloudflare Abuse Report...");

		const promise = page.waitForResponse((response) => response.url().includes("/api/v2/form/abuse_phishing"));
		await page.click(`button[type="submit"]`);
		const response = await promise;

		if (!response.ok()) {
			const text = await response.text();

			throw new Error(`Cloudflare abuse report submission failed: ${response.status()} ${text}`);
		}

		const json = await response.json();
		console.log("Cloudflare Abuse Report succesfully submitted:", json);

		await ReportsEntity.create({
			submissionId: params.submissionId,
			to: `Cloudflare Abuse`,
			body: `${params.explanation}
		Infringed Brand: ${params.infringedBrand!}`,
		});

		return json;
	} finally {
		await browser.close();
	}
}

// curl 'https://abuse.cloudflare.com/api/v2/form/abuse_phishing' \
//   -H 'sec-ch-ua-platform: "macOS"' \
//   -H 'Referer: https://abuse.cloudflare.com/phishing' \
//   -H 'X-Turnstile-Token: 0.7jaqYw7O3XZIXuarDnRuhSfZRsuUBEcqkRBcOPhEoTpMnijSQJj9mF-_oBZmvsYZWXDwQjr9Qwl8k8o1Uc_tnZC3sAKsnJP4pQeB9O3zERMcodcXQVxYrQQIOXGgz4agQdPo0pEjj4vcSVVXTHUX1_wiZlQ5EiJsTUOtD6PJobDpr7An2Fp-xI6-0ND2sTigVHQm0lEbGNE3BGnpB2YF0jODff7aDCH2lQclu0vAyaMPfLygXbBq-2kR5Quna-3gwdN-avOCKz5QglydtapqxOvHm4e05pLbH6JVnhuDtzQ3nCjBXscSZhG3q4tiY-MVX4HITjOoKGe_qX1fSFJXzBl_1LyfNaAR1jhhg9zJk5rr9gXJSRmfImPRQMSOlfxmal59dq78LBt67uDnP3FjlZPSqcxuhI4f4ZLfLHCnQZHNV_CjQRXGjwVtQjG-0P6yhIOUH0fjWH9ocAKAyY3F-lgpMCIrINBfky7u5YW2t-1tsAPprboL2mE1Kc77AgUopHoEpvAfzSzhkZ2VdJbdp4X8DxcnU6EZBkRUsDat4nlWZctigQcbMILsA52krSpt-3_UbTpB1BluwTXVppt3nwm11-vpRkGt9nWvKDGlqKFchrxGGnLBvbqJW0doGUhM28HbD_E9G575FT_Q0nUbnYNYUbHSzHIoytWc-MdVifZaXQFT2fsJytQPEJa7McCQj2TAhSlIKIl28fMDSxuxXyQX-KLz8_p9CYnq_GR8CDffxUvlwId6mQgyk6mYRGwvM364x0I-CNsAlDMTyN38nfNvlq-vmvur9Ph0mQ0muS6ilfioHHxyFR5S_rZsKsmxcTg39DY9zlhkt9OmRz5o7Xv6z1prZJDypHawft4oFGGfwouVxg2LyXe0R1aUiiyeAGCVekCM5BPWg5d7r1PmL_SsUMMJgjqkN9Igs4erRGVH6j9SBrcvEqVXvoMfxlso.MwR4Vk_yOiqUCr09F-UeAA.121550ec4df57b5f151855df008ee1f082324a54c4a2534708adc42b24b3e10c' \
//   -H 'sec-ch-ua: "Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"' \
//   -H 'sec-ch-ua-mobile: ?0' \
//   -H 'baggage: sentry-environment=production,sentry-release=7d1662f262303ecd470ec93ed337eecd64dd4ee4,sentry-public_key=a742b6bf97704481891a2ce4ac008066,sentry-trace_id=36026d6ad07f4023be27cae9d635f0ac,sentry-sample_rate=0.1,sentry-sampled=true' \
//   -H 'sentry-trace: 36026d6ad07f4023be27cae9d635f0ac-9410f930e7036782-1' \
//   -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36' \
//   -H 'Accept: application/json, text/plain, */*' \
//   -H 'DNT: 1' \
//   -H 'Content-Type: application/json' \
//   --data-raw '{"name":"awd","email":"efwef@e.de","email2":"efwef@e.de","title":"","company":"","tele":"","urls":"https://lumendatabase.org/","justification":"https://lumendatabase.org/","original_work":"","reported_country":"","reported_user_agent":"","comments":"","host_notification":"send-anon","owner_notification":"send-anon","dsa_attestation":true,"act":"abuse_phishing","cf-turnstile-response":"0.7jaqYw7O3XZIXuarDnRuhSfZRsuUBEcqkRBcOPhEoTpMnijSQJj9mF-_oBZmvsYZWXDwQjr9Qwl8k8o1Uc_tnZC3sAKsnJP4pQeB9O3zERMcodcXQVxYrQQIOXGgz4agQdPo0pEjj4vcSVVXTHUX1_wiZlQ5EiJsTUOtD6PJobDpr7An2Fp-xI6-0ND2sTigVHQm0lEbGNE3BGnpB2YF0jODff7aDCH2lQclu0vAyaMPfLygXbBq-2kR5Quna-3gwdN-avOCKz5QglydtapqxOvHm4e05pLbH6JVnhuDtzQ3nCjBXscSZhG3q4tiY-MVX4HITjOoKGe_qX1fSFJXzBl_1LyfNaAR1jhhg9zJk5rr9gXJSRmfImPRQMSOlfxmal59dq78LBt67uDnP3FjlZPSqcxuhI4f4ZLfLHCnQZHNV_CjQRXGjwVtQjG-0P6yhIOUH0fjWH9ocAKAyY3F-lgpMCIrINBfky7u5YW2t-1tsAPprboL2mE1Kc77AgUopHoEpvAfzSzhkZ2VdJbdp4X8DxcnU6EZBkRUsDat4nlWZctigQcbMILsA52krSpt-3_UbTpB1BluwTXVppt3nwm11-vpRkGt9nWvKDGlqKFchrxGGnLBvbqJW0doGUhM28HbD_E9G575FT_Q0nUbnYNYUbHSzHIoytWc-MdVifZaXQFT2fsJytQPEJa7McCQj2TAhSlIKIl28fMDSxuxXyQX-KLz8_p9CYnq_GR8CDffxUvlwId6mQgyk6mYRGwvM364x0I-CNsAlDMTyN38nfNvlq-vmvur9Ph0mQ0muS6ilfioHHxyFR5S_rZsKsmxcTg39DY9zlhkt9OmRz5o7Xv6z1prZJDypHawft4oFGGfwouVxg2LyXe0R1aUiiyeAGCVekCM5BPWg5d7r1PmL_SsUMMJgjqkN9Igs4erRGVH6j9SBrcvEqVXvoMfxlso.MwR4Vk_yOiqUCr09F-UeAA.121550ec4df57b5f151855df008ee1f082324a54c4a2534708adc42b24b3e10c"}'

// const turnstile_params = JSON.stringify({
// 	proxy: process.env.PROXY_URL,
// 	proxytype: "HTTP",
// 	sitekey: "0x4AAAAAAAa0L843_aKhfEFs",
// 	pageurl: "https://abuse.cloudflare.com/phishing",
// });

// const token = await new Promise<string>((resolve, reject) => {
// 	dbcClient.decode({ extra: { type: 12, turnstile_params } }, (captcha: any) => {
// 		if (captcha === null) {
// 			reject("Failed to solve CAPTCHA");
// 			return;
// 		}
// 		if (captcha) {
// 			try {
// 				console.log(captcha);

// 				resolve(captcha["text"]);
// 			} catch (err) {
// 				reject(err);
// 			}
// 		}
// 	});
// });
// const response = await fetch("https://abuse.cloudflare.com/api/v2/form/abuse_phishing", {
// 	headers: {
// 		accept: "application/json, text/plain, */*",
// 		"accept-language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7,ja;q=0.6",
// 		"cache-control": "no-cache",
// 		"content-type": "application/json",
// 		pragma: "no-cache",
// 		priority: "u=1, i",
// 		"sec-ch-ua": '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
// 		"sec-ch-ua-mobile": "?0",
// 		"sec-ch-ua-platform": '"macOS"',
// 		"sec-fetch-dest": "empty",
// 		"sec-fetch-mode": "cors",
// 		"sec-fetch-site": "same-origin",
// 		"x-turnstile-token": token,
// 		Referer: "https://abuse.cloudflare.com/phishing",
// 		"user-agent": userAgent,
// 	},
// 	body: JSON.stringify({
// 		name: abuseReplyName,
// 		email: abuseReplyMail,
// 		email2: abuseReplyMail,
// 		title: "",
// 		company: "https://phishing.support/",
// 		tele: "",
// 		urls: `${params.url}`, // Evidence URLs
// 		justification: `The URL ${params.url} is considered to be a phishing website.
// More information can be found here: https://phishing.support/submissions/${params.submissionId}`, // Logs or other evidence of abuse, This field may be released by Cloudflare to third parties such as the Lumen Database.

// 		original_work: params.infringedBrand || "", // Provide a URL or description of the legitimate brand being phished or spoofed.
// 		reported_country: params.countryCode?.toUpperCase() ?? "DE",
// 		reported_user_agent: userAgent,
// 		comments: "", // Comments are kept internal to Cloudflare and not shared with the host or customer as part of regular processing.

// 		host_notification: "send-anon",
// 		owner_notification: "send-anon",
// 		dsa_attestation: true,
// 		act: "abuse_phishing",
// 		"cf-turnstile-response": token,
// 	}),
// 	method: "POST",
// });
