import * as toon from "@toon-format/toon";
import { uniqBy } from "lodash";
import { WhoISInfo } from "../website_info";
import { generateReportDraft } from "./generateReportDraft";
import { sendReportEmail } from "./sendReportEmail";

export async function reportWebsitePhishing(params: {
	submissionId: bigint;
	url: string;
	whois: WhoISInfo;
	analysisText: string;
	archive: { screenshotPng: Buffer; mhtml: Buffer };
	countryCode?: string;
}) {
	const generalNotes = `Write on behalf of "the team of phishing.support".
Write to them if they need further information about this case; they can find it at https://phishing.support/submissions/${params.submissionId}
Tone: professional and factual.`;

	const ipAbuseEmails = params.whois.ip_rdaps.map((x) => {
		if (!x.abuse?.email) return;

		const system = `You are an expert phishing analyst. Draft a concise report to the abuse contact about a phishing website hosted on their ip space/server infrastructure.

The report must include:
1) A short summary of the phishing analysis.
2) The phishing website URL and relevant dns information to identify the infrastructure (dns record, ip).
3) A clear request for investigation and takedown/mitigation.

${generalNotes}
`;

		const user = `Draft the report based on this analysis:

${params.analysisText}

Phishing Website URL:
${params.url}

WhoIS/DNS:
${toon.encode(params.whois)}

Contact the server provider of the IP address:
${x.ip}
The abuse contact is
${toon.encode(x.abuse)}`;

		return {
			system,
			user,
			email: x.abuse.email,
		};
	});

	const domainAbuseEmails = [params.whois.rdap, params.whois.root_info?.rdap].map((x) => {
		if (!x?.registrar?.abuse?.email) return;

		const system = `You are an expert phishing analyst. Draft a concise report to the abuse contact of the domain registrar of the phishing website.

The report must include:
1) A short summary of the phishing analysis.
2) The phishing website URL and relevant dns information to identify the infrastructure (DNS, registrar, registration date, etc).
3) A request for investigation and takedown/mitigation.

${generalNotes}`;

		const user = `Draft the report based on this analysis:

${params.analysisText}

Phishing Website URL:
${params.url}

WhoIS/DNS:
${toon.encode(params.whois)}

Contact the domain registrar:
${toon.encode(x.registrar)}
`;

		return {
			system,
			user,
			email: x.registrar.abuse.email,
		};
	});

	const promises = uniqBy(
		[...ipAbuseEmails, ...domainAbuseEmails].filter((x) => x !== undefined),
		(x) => x.email
	).map(async ({ email, system, user }) => {
		if (email === "dnsabuse_complaint@tencent.com") {
			const { reportTencentCloudAbuse } = await import("./tencentCloudAbuse");
			return await reportTencentCloudAbuse({
				url: params.url,
				submissionId: params.submissionId,
				analysisText: params.analysisText,
				websiteScreenshot: params.archive.screenshotPng,
			});
		} else if (email === "abuse@cloudflare.com") {
			const { reportCloudflareAbuse } = await import("./cloudflareAbuse");
			return await reportCloudflareAbuse({
				url: params.url,
				submissionId: params.submissionId,
				analysisText: params.analysisText,
				countryCode: params.countryCode,
			});
		}

		const draft = await generateReportDraft({
			submissionId: params.submissionId,
			system,
			user,
		});

		await sendReportEmail({
			submissionId: params.submissionId,
			draft,
			attachments: [
				{
					filename: "website.mhtml",
					content: params.archive.mhtml,
					contentType: "text/mhtml",
				},
				{
					filename: "website.png",
					content: params.archive.screenshotPng,
					contentType: "image/png",
				},
			],
			data: { url: params.url },
		});
	});

	return Promise.allSettled(promises);
}
