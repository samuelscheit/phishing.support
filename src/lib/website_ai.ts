import * as toon from "@toon-format/toon";
import { archiveWebsite } from "./website_archive";
import { SubmissionsEntity, ArtifactsEntity, ReportsEntity } from "./db/entities";
import { getInfo } from "./website_info";
import { runStreamedAnalysisRun } from "./analysis_run";
import { publishEvent } from "./event/event_transport";
import { markSubmissionInvalid, reportToGoogleSafeBrowsing, reportWebsitePhishing } from "./report";
import { defaultReasoning, defaultResponseModel } from "./utils";

export async function emitStep(streamId: bigint | string | undefined, step: string, progress: number) {
	if (!streamId) return;
	await publishEvent(`run:${streamId}`, { type: "analysis.step", step, progress });
}

export function retry(fn: () => Promise<any>, retries: number = 3, delayMs: number = 5000): Promise<any> {
	return fn().catch((err) => {
		if (retries > 0) {
			return new Promise((resolve) => setTimeout(resolve, delayMs)).then(() => retry(fn, retries - 1, delayMs));
		} else {
			return Promise.reject(err);
		}
	});
}

type WebsiteEvidenceArchive = {
	url: string;
	hostname: string;
	html: Buffer;
	text: Buffer;
	screenshotPng?: Buffer;
};

export function buildWebsiteEvidence(params: { url: string; whois: unknown; archive: WebsiteEvidenceArchive; analysisText?: string }) {
	const analysis = params.analysisText?.trim();
	return toon.encode({
		url: params.url,
		archive_url: params.archive.url,
		hostname: params.archive.hostname,
		website_text: params.archive.text.toString("utf-8").slice(0, 12000),
		html_excerpt: params.archive.html.toString("utf-8").slice(0, 12000),
		whois: params.whois,
		...(analysis ? { analysis } : {}),
	});
}

function reportEvidenceText(params: { url: string; whois: unknown; archive: WebsiteEvidenceArchive; analysisText?: string }) {
	const analysis = params.analysisText?.trim();
	if (analysis) return analysis;

	return `The detailed analysis run did not produce a separate prose summary. Use the original captured website evidence below.

Evidence:
${buildWebsiteEvidence(params)}`;
}

export function buildWebsiteClassificationInput(params: { url: string; whois: unknown; archive: WebsiteEvidenceArchive; analysisText?: string }) {
	return [
		{
			role: "system" as const,
			content: `Classify the website from the supplied evidence. Answer {"phishing":true} if the captured website is phishing, credential theft, payment fraud, delivery-scam abuse, malicious, or strongly impersonates a trusted brand. Answer {"phishing":false} only when the captured evidence supports a legitimate/benign website.

Important: classify the captured archive/screenshot evidence, not the result of a later live visit. Some phishing sites redirect scanners or repeat visits to benign brands. Do not treat a benign redirect as proof of legitimacy when the archive evidence shows impersonation or credential/payment collection. Provide no other text.`,
		},
		{
			role: "user" as const,
			content: [
				{
					type: "input_text" as const,
					text: `Evidence:\n${buildWebsiteEvidence(params)}`,
				},
				...(params.archive.screenshotPng
					? [
							{
								type: "input_image" as const,
								detail: "high" as const,
								image_url: `data:image/png;base64,${params.archive.screenshotPng.toString("base64")}`,
							},
						]
					: []),
			],
		},
	];
}

export async function analyzeWebsite(options: {
	mhtmlSnapshot?: Buffer;
	url: string;
	submissionId: bigint;
	country_code?: string;
}): Promise<bigint> {
	const { url, submissionId, country_code } = options!;
	try {
		await emitStep(submissionId, "whois_lookup", 5);
		const whois = await getInfo(url);

		await SubmissionsEntity.update(submissionId, {
			status: "running",
			data: {
				kind: "website",
				website: {
					url,
					whois,
				},
			},
		});

		await emitStep(submissionId, "archive_website", 10);
		const archive = await retry(() => archiveWebsite(options), 2, 3000);
		await emitStep(submissionId, "save_artifacts", 40);

		// await ArtifactsEntity.saveWebsiteArtifacts({ submissionId, archive });
		await ArtifactsEntity.saveWebsiteArtifacts({ submissionId, archive });

		await emitStep(submissionId, "analysis_run", 45);

		const { result: analysis } = await runStreamedAnalysisRun({
			submissionId,
			options: {
				model: defaultResponseModel,
				input: [
					{
						role: "user" as const,
						content: [
							{
								type: "input_text" as const,
								text: `You are an expert phishing website analyst. Your task is to analyze the provided website and determine if it is a phishing website.
URL: ${url}
WhoIs information:
${toon.encode(whois)}

Here is the website text content:
<website_text>
${archive.text.toString().slice(0, 10000)}
</website_text>

Here is the website raw html skeleton:
${archive.html.toString().slice(0, 10000)}

Please provide a detailed phishing analysis of the website.
Research if the website impersonates another brand/service using web_search. If possible the exact impersonated brand website URL address.
Use web search if necessary to gather more information about the content/brand. (the website might be new and doesn't have any web results yet). (you are not be able to access the website directly use the provided website text, html and screenshot).`,
							},
							{
								type: "input_image" as const,
								detail: "high" as const,
								image_url: `data:image/png;base64,${archive.screenshotPng.toString("base64")}`,
							},
						],
					},
				],
				reasoning: defaultReasoning,
				tools: [{ type: "web_search" }],
				stream: true,
			},
		});

		await emitStep(submissionId, "structured_response", 75);
		const { result: structuredResponse } = await runStreamedAnalysisRun({
			submissionId,
			options: {
				model: defaultResponseModel,
				input: buildWebsiteClassificationInput({ url, whois, archive, analysisText: analysis.output_text }),
				text: {
					format: {
						type: "json_schema",
						name: "PhishingResult",
						schema: {
							type: "object",
							properties: {
								phishing: { type: "boolean" },
							},
							required: ["phishing"],
							additionalProperties: false,
						},
						strict: true,
					},
					verbosity: "low",
				},
				stream: true,
			},
		});

		const { phishing } = structuredResponse.output_parsed || ({} as { phishing: boolean });
		if (typeof phishing !== "boolean") {
			throw new Error(`Failed to classify website phishing result: ${structuredResponse.output_text}`);
		}

		if (phishing) {
			await emitStep(submissionId, "reporting", 90);
			const analysisText = reportEvidenceText({ url, whois, archive, analysisText: analysis.output_text });
			await reportWebsitePhishing({
				submissionId,
				url,
				whois,
				analysisText,
				archive: {
					screenshotPng: archive.screenshotPng,
					mhtml: archive.mhtml,
				},
				countryCode: country_code,
			});

			await emitStep(submissionId, "reporting to Google Safe Browsing", 90);

			try {
				await reportToGoogleSafeBrowsing({
					url,
					submissionId,
					analysisText,
				});
			} catch (err) {
				console.error("Failed to report to Google Safe Browsing:", err);
			}

			const reports = await ReportsEntity.listForSubmission(submissionId);
			if (reports.length > 0) {
				await SubmissionsEntity.update(submissionId, { status: "reported" });
			} else {
				await SubmissionsEntity.update(submissionId, {
					status: "failed",
					info: "Phishing confirmed, but no reports were successfully submitted.",
				});
			}
		} else {
			await markSubmissionInvalid(submissionId);
		}

		await emitStep(submissionId, "completed", 100);
	} catch (error) {
		console.error("Website analysis failed:", error);
		await SubmissionsEntity.update(submissionId, { status: "failed", info: String(error) });
		await emitStep(submissionId, "failed", 100);
	}

	return submissionId;
}
