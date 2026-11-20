import { ArtifactsEntity } from "./db/entities/artifacts";
import { SubmissionsEntity } from "./db/entities/submissions";
import { runStreamedAnalysisRun } from "./analysis_run";
import { publishEvent } from "./event/event_transport";
import { simpleParser } from "mailparser";
import { analyzeHeaders, getAddressesText, getMailImage, getMailWebsiteUrls } from "./mail";
import { getInfo } from "./website_info";
import { cleanPrivateInformation, isServiceAddress } from "./mail_redaction";
import * as toon from "@toon-format/toon";
import { reportConfirmedEmailPhishing } from "./abuse/submission_reports";
import { smtpReturnPath, smtpSender, smtpTransport } from "./mail_config";
import { createWebsiteSubmission } from "./submissions/website";
import { defaultReasoning, defaultResponseModel } from "./openai_client";
import { serviceIdentity } from "./constants";
import { errorText } from "./error_text";
import type { EmailSubmissionData } from "./db/schema";
import type { ReporterMetadata } from "./request_metadata";

function buildMailEvidence(mail: MailData, analysisText?: string) {
	return toon.encode({
		from: mail.from,
		subject: mail.subject,
		text: mail.text,
		html_excerpt: mail.html.slice(0, 12000),
		urls: getMailWebsiteUrls(mail),
		headers: mail.headers,
		whois: mail.whois,
		analysis: analysisText || undefined,
	});
}

async function emitStep(streamId: bigint | string | undefined, step: string, progress: number) {
	if (!streamId) return;
	await publishEvent(`run:${streamId}`, { type: "analysis.step", step, progress });
}

export type ParseMailDependencies = {
	getInfo?: typeof getInfo;
};

export async function parseMail(eml: string, dependencies: ParseMailDependencies = {}) {
	const parsedMail = await simpleParser(eml, {});

	const headers = analyzeHeaders(parsedMail.headerLines.map((x) => x.line).join("\n"));

	let whois = undefined;

	if (headers.routing.originatingIp || headers.routing.originatingServer) {
		try {
			whois = await (dependencies.getInfo ?? getInfo)(headers.routing.originatingIp || headers.routing.originatingServer!);
		} catch (error) {
			console.error("Failed to get WHOIS info for mail origin:", error, headers.routing);
		}
	}

	return {
		eml,
		date: parsedMail.date?.getTime() || Date.now(),
		from: getAddressesText(parsedMail.from),
		from_object: parsedMail.from?.value[0],
		to: getAddressesText(parsedMail.to),
		to_object: Array.isArray(parsedMail.to) ? parsedMail.to[0].value[0] : parsedMail.to?.value[0],
		cc: getAddressesText(parsedMail.cc),
		bcc: getAddressesText(parsedMail.bcc),
		subject: parsedMail.subject || "",
		text: (parsedMail.text || "")
			.replaceAll(/(\r?\n)+/g, "\n")
			.replaceAll(/\n/g, " ")
			.trim(),
		html: parsedMail.html || "",
		headers: {
			...headers,
			routing: {
				...headers.routing,
			},
		},
		whois,
	};
}

export type MailData = Awaited<ReturnType<typeof parseMail>>;

/**
 * Every page a confirmed phishing mail links to is analyzed and, if confirmed,
 * reported as its own website. The returned links name the case each one
 * landed in, so the email case can show where its links went.
 */
export async function handOffMailLinks(params: {
	mail: MailData;
	submissionId: bigint;
	reporter: ReporterMetadata;
	createWebsite?: typeof createWebsiteSubmission;
}): Promise<NonNullable<EmailSubmissionData["linkedWebsites"]>> {
	const createWebsite = params.createWebsite ?? createWebsiteSubmission;
	const linked: NonNullable<EmailSubmissionData["linkedWebsites"]> = [];
	for (const url of getMailWebsiteUrls(params.mail)) {
		try {
			const submissionId = await createWebsite({ url, source: `email:${params.submissionId.toString()}`, ...params.reporter });
			linked.push({ url, submissionId: submissionId.toString() });
		} catch (error) {
			console.error(`Failed to open a website case for ${url} linked from email ${params.submissionId.toString()}:`, error);
		}
	}
	return linked;
}

const ANALYSIS_SYSTEM_PROMPT = `You are an expert email phishing analyst. Your task is to determine whether the email below is phishing, malicious, or legitimate.

Your analysis must include:
1) Brand impersonation check
	- does it mimic a known company/service?
	- Does the used email domain match the official domain of that brand? Use web search to verify.
2) Link analysis:
	- List every URL found.
	- For each: visible text vs actual URL (if available), domain reputation cues, lookalikes/typos, URL shorteners, redirects, unusual paths (use web search to follow links)
	- Identify the “primary action” the email tries to push.
3) Sender authenticity checks (based on headers if provided):
	- SPF, DKIM, DMARC results and alignment
	- Return-Path vs From mismatch
	- Reply-To mismatch
	- Received chain anomalies, unusual sending IP/ASN or geolocation (if inferable)
4) Content red flags:
	- credential collection, payment request, QR codes, fake invoices, “verify account”, “unusual activity”, etc.`;

const CLASSIFICATION_SYSTEM_PROMPT = `Classify the email from the supplied evidence. Answer {"phishing":true} if the email is phishing, credential theft, payment fraud, delivery-scam abuse, malicious, or strongly impersonates a trusted brand. Answer {"phishing":false} only when the evidence supports a legitimate/benign email. Do not treat SPF/DKIM/DMARC pass as proof of legitimacy when the authenticated domain itself is unrelated to the impersonated brand. Provide no other text.`;

type ReporterNotification = { subject: string; body: string };

/**
 * The mail screenshot and the raw EML are evidence artifacts. A re-run reuses
 * the stored screenshot instead of re-rendering the mail; a fresh run renders
 * it (best effort, since a missing screenshot must not block analysis) and
 * stores both.
 */
async function collectEvidenceArtifacts(submissionId: bigint, mail: MailData, reuseEvidenceArtifacts: boolean): Promise<Buffer | undefined> {
	if (reuseEvidenceArtifacts) {
		const stored = (await ArtifactsEntity.listForSubmission(submissionId)).find((artifact) => artifact.kind === "screenshot");
		return stored ? (await ArtifactsEntity.get(stored.id))?.blob : undefined;
	}

	let screenshotPng: Buffer | undefined;
	try {
		screenshotPng = await getMailImage(mail);
		await ArtifactsEntity.saveBuffer({
			submissionId,
			name: "mail.png",
			kind: "screenshot",
			mimeType: "image/png",
			buffer: screenshotPng,
		});
	} catch {
		// Screenshot generation is supplementary evidence and must not block analysis.
	}

	await ArtifactsEntity.saveBuffer({
		submissionId,
		name: "mail.eml",
		kind: "eml",
		mimeType: "message/rfc822",
		buffer: Buffer.from(mail.eml, "utf-8"),
	});
	return screenshotPng;
}

/** The first model run: a free-form web-searching analysis of the mail. */
async function runMailAnalysis(submissionId: bigint, mail: MailData): Promise<string> {
	const { result } = await runStreamedAnalysisRun({
		submissionId,
		analysisKind: "analysis",
		options: {
			model: defaultResponseModel,
			input: [
				{ role: "system", content: ANALYSIS_SYSTEM_PROMPT },
				{ role: "user", content: `analyze this email:\n${toon.encode({ ...mail, eml: undefined })}` },
			],
			reasoning: defaultReasoning,
			tools: [{ type: "web_search" }],
			stream: true,
		},
	});
	return result.output_text;
}

/** The second model run: a strict yes/no verdict derived from the mail and the analysis. */
async function classifyMailAsPhishing(submissionId: bigint, mail: MailData, analysisText: string): Promise<boolean> {
	const { result } = await runStreamedAnalysisRun({
		submissionId,
		analysisKind: "classification",
		options: {
			stream: true,
			model: defaultResponseModel,
			input: [
				{ role: "system", content: CLASSIFICATION_SYSTEM_PROMPT },
				{ role: "user", content: `Evidence:\n${buildMailEvidence(mail, analysisText)}` },
			],
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
		},
	});
	const { phishing } = result.output_parsed || ({} as { phishing?: unknown });
	if (typeof phishing !== "boolean") {
		throw new Error(`Failed to classify email phishing result: ${result.output_text}`);
	}
	return phishing;
}

/** Files the provider reports and opens a case for every linked website. */
async function reportConfirmedPhishing(params: { submissionId: bigint; mail: MailData; analysisText: string; screenshotPng?: Buffer }) {
	const { submissionId, mail } = params;
	const submission = await SubmissionsEntity.get(submissionId);
	const reporter = {
		reporterIp: submission?.reporterIp ?? undefined,
		reporterCountry: submission?.reporterCountry ?? undefined,
		reporterHeaders: submission?.reporterHeaders ?? undefined,
	};
	await reportConfirmedEmailPhishing({
		submissionId,
		analysisText: params.analysisText,
		redactedEml: mail.eml,
		sendingIp: mail.headers.routing.originatingIp,
		screenshotPng: params.screenshotPng,
		reporter,
	});
	const linkedWebsites = await handOffMailLinks({ mail, submissionId, reporter });
	await SubmissionsEntity.update(submissionId, { status: "reported", info: undefined, data: { kind: "email", email: { ...mail, linkedWebsites } } });
}

function reporterNotification(phishing: boolean, mail: MailData, submissionId: bigint): ReporterNotification {
	const date = mail.date ? new Date(mail.date).toLocaleString("en-US", { timeZone: "UTC" }) : undefined;
	const submissionSubject = `"${mail.from_object?.name || mail.from_object?.address}" ${date ? "from " + date : ""}`;

	if (phishing) {
		return {
			subject: `Phishing Reported - ${submissionSubject}`,
			body: [
				`Thank you very much for your report!`,
				"",
				`We have analyzed the email you provided and determined that it is indeed a phishing attempt.`,
				"",
				`Your submission is being reported to the email providers and hosting services involved.`,
				`You can follow each report at: ${serviceIdentity.url}/submissions/${submissionId}`,
				"",
				`Thank you for helping to combat phishing!`,
				`Your ${serviceIdentity.name} Team`,
			].join("\n"),
		};
	}

	return {
		subject: `Not Phishing - ${submissionSubject}`,
		body: [
			`Thank you for your report. We analyzed the email you provided and determined that it is not a phishing attempt.`,
			"",
			`As a result, we have marked this submission as invalid.`,
			`You can view details at: ${serviceIdentity.url}/submissions/${submissionId}`,
			"",
			`If you believe this is an error, please feel free to reach out to us at ${serviceIdentity.mailbox}.`,
			"",
			`Thank you for helping to combat phishing!`,
			`Your ${serviceIdentity.name} Team`,
		].join("\n"),
	};
}

/** Tells the reporter the verdict. Best effort: a failed notification must not fail the analysis. */
async function notifyReporter(submissionId: bigint, to: string | undefined, { subject, body }: ReporterNotification) {
	try {
		const from = `${serviceIdentity.name} <${smtpSender()}>`;
		console.log(`Sending reporter notification email to ${to} from ${from} for submission ${submissionId}. Subject: ${subject} Body: ${body}`);
		if (to) await smtpTransport()?.sendMail({ from, to, subject, text: body, envelope: { from: smtpReturnPath(), to: [to] } });
	} catch (err) {
		console.error("Failed to send reporter notification email:", err);
	}
}

export async function analyzeMail(emlContent: string, stream_id: bigint, options: { reuseEvidenceArtifacts?: boolean } = {}) {
	try {
		const originalMail = await parseMail(emlContent);
		const mail = cleanPrivateInformation(originalMail);

		await emitStep(stream_id, "start", 0);
		await SubmissionsEntity.update(stream_id, { status: "running", data: { kind: "email", email: mail } });

		const screenshotPng = await collectEvidenceArtifacts(stream_id, mail, options.reuseEvidenceArtifacts ?? false);

		await emitStep(stream_id, "analysis_run", 30);
		const analysisText = await runMailAnalysis(stream_id, mail);

		await emitStep(stream_id, "structured_response", 70);
		const phishing = await classifyMailAsPhishing(stream_id, mail, analysisText);

		if (phishing) {
			await emitStep(stream_id, "reporting", 90);
			await reportConfirmedPhishing({ submissionId: stream_id, mail, analysisText, screenshotPng });
		} else {
			await SubmissionsEntity.update(stream_id, { status: "invalid" });
		}

		// A mail addressed to the service itself has no reporter mailbox to answer.
		const reporterAddress = originalMail.to_object?.address;
		const to = reporterAddress && !isServiceAddress(reporterAddress) ? reporterAddress : undefined;
		await notifyReporter(stream_id, to, reporterNotification(phishing, mail, stream_id));

		await emitStep(stream_id, "completed", 100);
	} catch (error) {
		console.error("Email analysis failed:", error);
		await SubmissionsEntity.update(stream_id, { status: "failed", info: errorText(error) });
		await emitStep(stream_id, "failed", 100);
	}
}
