import * as toon from "@toon-format/toon";
import { MailData } from "../mail_ai";
import { generateReportDraft } from "./generateReportDraft";
import { sendReportEmail } from "./sendReportEmail";
import { getMailLinks } from "../mail";
import { createWebsiteSubmission } from "../../app/api/submissions/website/route";

export async function reportEmailPhishing(params: { submissionId: bigint; mail: MailData; analysisText: string }) {
	try {
		getMailLinks(params.mail).forEach((link) => {
			if (!URL.canParse(link.href)) return;
			const url = new URL(link.href);
			if (url.protocol !== "http:" && url.protocol !== "https:") return;

			createWebsiteSubmission({
				url: url.toString(),
				source: `email:${params.submissionId.toString()}`,
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
				filename: "original.eml",
				content: Buffer.from(params.mail.eml, "utf-8"),
				contentType: "message/rfc822",
			},
		],
	});
}
