import * as toon from "@toon-format/toon";
import { MailData } from "../mail_ai";
import { generateReportDraft } from "./generateReportDraft";
import { sendReportEmail } from "./sendReportEmail";
import { getMailLinks } from "../mail";
import { createWebsiteSubmission } from "../submissions/website";
import { SubmissionsEntity } from "../db/entities";
import type { ReporterMetadata } from "../request_metadata";
import { reportNetcraftMail } from "./netcraft_mail";

type EmailPhishingReportingDependencies = {
	generateReportDraft?: typeof generateReportDraft;
	sendReportEmail?: typeof sendReportEmail;
	reportNetcraftMail?: typeof reportNetcraftMail;
};

function logReportFailure(channel: string, reason: unknown) {
	console.error(`${channel} report failed:`, reason);
}

async function reportSendingInfrastructure(
	params: { submissionId: bigint; mail: MailData; analysisText: string; originalEmlArtifactId?: bigint },
	dependencies: Pick<EmailPhishingReportingDependencies, "generateReportDraft" | "sendReportEmail">,
) {
	let reporter: ReporterMetadata | undefined;
	try {
		const submission = await SubmissionsEntity.get(params.submissionId);
		reporter = submission
			? {
					reporterIp: submission.reporterIp ?? undefined,
					reporterCountry: submission.reporterCountry ?? undefined,
					reporterHeaders: submission.reporterHeaders ?? undefined,
				}
			: undefined;
	} catch (error) {
		console.error("Failed to load reporter metadata for linked website submissions:", error);
	}

	try {
		getMailLinks(params.mail).forEach((link) => {
			if (!URL.canParse(link.href)) return;
			const url = new URL(link.href);
			if (url.protocol !== "http:" && url.protocol !== "https:") return;

			createWebsiteSubmission({
				url: url.toString(),
				source: `email:${params.submissionId.toString()}`,
				...reporter,
			}).catch(console.error);
		});
	} catch (error) {
		console.error("Error extracting mail links:", error);
	}

	const system = `You are an expert email phishing analyst. Draft a concise report to the abuse contact of the sending IP's owner, reporting a phishing email that originated from their infrastructure.

The report must include:
1) A brief summary of the phishing email (brand impersonated, main action pushed).
2) The sending IP/domain used and any relevant header signals.
3) A request for investigation and mitigation.

The original phishing email with full headers will be attached.
Write on behalf of "the team of phishing.support".
Write to them if they need further information about this case; they can find it at https://phishing.support/submissions/${params.submissionId}
Tone: professional and factual.`;

	const user = `Draft the report based on this analysis:

${params.analysisText}

Email:
${toon.encode({ ...params.mail, eml: undefined })}
}`;

	const draft = await (dependencies.generateReportDraft ?? generateReportDraft)({
		submissionId: params.submissionId,
		system,
		user,
	});

	return await (dependencies.sendReportEmail ?? sendReportEmail)({
		submissionId: params.submissionId,
		analysisRunId: draft.analysisRunId,
		draft,
		attachments: [
			{
				filename: "original.eml",
				content: Buffer.from(params.mail.eml, "utf-8"),
				contentType: "message/rfc822",
			},
		],
	});
}

/**
 * File every confirmed phishing email with Netcraft independently of the
 * sender-infrastructure SMTP report. A draft-generation or SMTP failure must
 * never suppress the direct Netcraft submission.
 */
export async function reportEmailPhishing(
	params: { submissionId: bigint; mail: MailData; analysisText: string; originalEmlArtifactId?: bigint },
	dependencies: EmailPhishingReportingDependencies = {},
) {
	const netcraft = dependencies.reportNetcraftMail ?? reportNetcraftMail;
	const [netcraftResult, smtpResult] = await Promise.allSettled([
		netcraft({
			submissionId: params.submissionId,
			rawMime: params.mail.eml,
			originalEmlArtifactId: params.originalEmlArtifactId,
		}),
		reportSendingInfrastructure(params, dependencies),
	]);

	if (netcraftResult.status === "rejected") logReportFailure("Netcraft mail", netcraftResult.reason);
	if (smtpResult.status === "rejected") logReportFailure("SMTP sender-infrastructure", smtpResult.reason);
	return { netcraft: netcraftResult, smtp: smtpResult };
}
