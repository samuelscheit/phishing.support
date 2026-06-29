import { ArtifactsEntity, SubmissionsEntity } from "./db/entities";
import { runStreamedAnalysisRun } from "./analysis_run";
import { publishEvent } from "./event/event_transport";
import { simpleParser } from "mailparser";
import { analyzeHeaders, getAddressesText, getMailImage } from "./mail";
import { getInfo } from "./website_info";
import * as toon from "@toon-format/toon";
import { markSubmissionInvalid, reportEmailPhishing } from "./report";
import { defaultReasoning, defaultResponseModel, mailer } from "./utils";
import { abuseReplyMail, abuseReplyName, abuseReplyUrl } from "./constants";

async function emitStep(streamId: bigint | string | undefined, step: string, progress: number) {
	if (!streamId) return;
	await publishEvent(`run:${streamId}`, { type: "analysis.step", step, progress });
}

function recursiveClean(node: any, info: string[]): any {
	if (Array.isArray(node)) {
		return node.map((x) => recursiveClean(x, info));
	} else if (node && typeof node === "object") {
		const cleaned: any = {};
		for (const [key, value] of Object.entries(node)) {
			if (value !== undefined && value !== null) {
				cleaned[key] = recursiveClean(value, info);
			}
		}
		return cleaned;
	} else if (typeof node === "string") {
		let cleaned = node;
		for (const inf of info) {
			const regex = inf.replaceAll(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
			cleaned = cleaned.replace(new RegExp(`(\\s${regex})|(${regex}\\s)`, "gi"), "[redacted]");
		}
		return cleaned;
	} else {
		return node;
	}
}

export function cleanPrivateInformation(mail: MailData) {
	const infos = [mail.to_object?.address, mail.to_object?.name].filter((x) => x !== undefined && x?.length > 3);

	// TODO: extract name from greetings

	return recursiveClean(mail, infos as string[]) as MailData;
}

export async function parseMail(eml: string) {
	const parsedMail = await simpleParser(eml, {});

	const headers = analyzeHeaders(parsedMail.headerLines.map((x) => x.line).join("\n"));

	let whois = undefined;

	if (headers.routing.originatingIp || headers.routing.originatingServer) {
		try {
			whois = await getInfo(headers.routing.originatingIp || headers.routing.originatingServer!);
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

export async function analyzeMail(emlContent: string, stream_id: bigint) {
	try {
		const privateMail = await parseMail(emlContent);
		const mail = cleanPrivateInformation(privateMail);

		await emitStep(stream_id, "start", 0);
		await SubmissionsEntity.update(stream_id, { status: "running", data: { kind: "email", email: mail } });

		try {
			const image = await getMailImage(mail);
			await ArtifactsEntity.saveBuffer({
				submissionId: stream_id,
				name: "mail.png",
				kind: "screenshot",
				mimeType: "image/png",
				buffer: image,
			});
		} catch (error) {}

		// Save EML artifact
		await ArtifactsEntity.saveBuffer({
			submissionId: stream_id,
			name: "mail.eml",
			kind: "eml",
			mimeType: "message/rfc822",
			buffer: Buffer.from(mail.eml, "utf-8"),
		});

		await emitStep(stream_id, "analysis_run", 30);

		const { result: analysis } = await runStreamedAnalysisRun({
			submissionId: stream_id,
			options: {
				model: defaultResponseModel,
				input: [
					{
						role: "system",
						content: `You are an expert email phishing analyst. Your task is to determine whether the email below is phishing, malicious, or legitimate.

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
	- credential collection, payment request, QR codes, fake invoices, “verify account”, “unusual activity”, etc.`,
					},
					{
						role: "user",
						content: `analyze this email:
${toon.encode({ ...mail, eml: undefined })}`,
					},
				],
				reasoning: defaultReasoning,
				tools: [{ type: "web_search" }],
				stream: true,
			},
		});

		await emitStep(stream_id, "structured_response", 70);

		const { result: structuredResponse } = await runStreamedAnalysisRun({
			submissionId: stream_id,
			options: {
				stream: true,
				model: defaultResponseModel,
				input: [
					{
						role: "system",
						content: `Answer {"phishing":true} if the analysis concludes that the email is phishing or malicious. Otherwise answer {"phishing":false}. Provide no other text.`,
					},
					{
						role: "user",
						content: `Analysis Text: ${analysis.output_text}`,
					},
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
		const { phishing } = structuredResponse.output_parsed || ({} as { phishing: boolean });

		const from = process.env.SMTP_FROM || `${abuseReplyName} <${abuseReplyMail}>`;
		const date = mail.date ? new Date(mail.date).toLocaleString("en-US", { timeZone: "UTC" }) : undefined;
		const submissionSubject = `"${mail.from_object?.name || mail.from_object?.address}" ${date ? "from " + date : ""}`;
		let to = privateMail.to_object?.address;

		if (to?.endsWith("@phishing.support")) {
			to = undefined;
		}

		if (phishing) {
			await emitStep(stream_id, "reporting", 90);
			await reportEmailPhishing({
				submissionId: stream_id,
				mail,
				analysisText: analysis.output_text,
			});

			var subject = `Phishing Reported - ${submissionSubject}`;
			var body = [
				`Thank you very much for your report!`,
				"",
				`We have analyzed the email you provided and determined that it is indeed a phishing attempt.`,
				"",
				`Your submission has been reported to the relevant email providers and hosting services involved.`,
				`You can view details at: ${abuseReplyUrl}/submissions/${stream_id}`,
				"",
				`Thank you for helping to combat phishing!`,
				`Your ${abuseReplyName} Team`,
			].join("\n");
		} else {
			await markSubmissionInvalid(stream_id);

			var subject = `Not Phishing - ${submissionSubject}`;
			var body = [
				`Thank you for your report. We analyzed the email you provided and determined that it is not a phishing attempt.`,
				"",
				`As a result, we have marked this submission as invalid.`,
				`You can view details at: ${abuseReplyUrl}/submissions/${stream_id}`,
				"",
				`If you believe this is an error, please feel free to reach out to us at ${abuseReplyMail}.`,
				"",
				`Thank you for helping to combat phishing!`,
				`Your ${abuseReplyName} Team`,
			].join("\n");
		}

		// Send a brief notification back to the reporter with the result and a link
		try {
			console.log(
				`Sending reporter notification email to ${to} from ${from} for submission ${stream_id}. Subject: ${subject} Body: ${body}`
			);
			if (to && from && subject && body) {
				await mailer?.sendMail({ from, to, subject, text: body });
			}
		} catch (err) {
			console.error("Failed to send reporter notification email:", err);
		}

		await emitStep(stream_id, "completed", 100);
	} catch (error) {
		console.error("Email analysis failed:", error);
		await SubmissionsEntity.update(stream_id, { status: "failed", info: String(error) });
		await emitStep(stream_id, "failed", 100);
	}
}
