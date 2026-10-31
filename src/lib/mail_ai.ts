import { ArtifactsEntity, SubmissionsEntity } from "./db/entities";
import { runStreamedAnalysisRun } from "./analysis_run";
import { publishEvent } from "./event/event_transport";
import { simpleParser } from "mailparser";
import { analyzeHeaders, getAddressesText, getMailImage, getMailLinks } from "./mail";
import { getInfo } from "./website_info";
import * as toon from "@toon-format/toon";
import { reportConfirmedEmailPhishing } from "./abuse/submission_reports";
import { smtpSender, smtpTransport } from "./mail_config";
import { markSubmissionInvalid } from "./submissions/state";
import { createWebsiteSubmission } from "./submissions/website";
import { defaultReasoning, defaultResponseModel } from "./utils";
import { serviceIdentity } from "./constants";
import { errorText } from "./error_text";

const URL_RE = /https?:\/\/[^\s"'<>]+/gi;

export function extractEmailUrls(mail: MailData) {
	return Array.from(new Set([...(mail.text.match(URL_RE) ?? []), ...(mail.html.match(URL_RE) ?? [])]));
}

export function buildMailEvidence(mail: MailData, analysisText?: string) {
	return toon.encode({
		from: mail.from,
		subject: mail.subject,
		text: mail.text,
		html_excerpt: mail.html.slice(0, 12000),
		urls: extractEmailUrls(mail),
		headers: mail.headers,
		whois: mail.whois,
		analysis: analysisText || undefined,
	});
}

async function emitStep(streamId: bigint | string | undefined, step: string, progress: number) {
	if (!streamId) return;
	await publishEvent(`run:${streamId}`, { type: "analysis.step", step, progress });
}

function escapeRegExp(value: string) {
	return value.replaceAll(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

function quotedPrintableEncodedWord(value: string) {
	return Array.from(Buffer.from(value, "utf-8"))
		.map((byte) => {
			const char = String.fromCharCode(byte);
			if (/^[A-Za-z0-9!*+\-/]$/.test(char)) return char;
			if (char === " ") return "_";
			return `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
		})
		.join("");
}

function mimeEncodedWordVariants(value: string) {
	const base64 = Buffer.from(value, "utf-8").toString("base64");
	const quotedPrintable = quotedPrintableEncodedWord(value);
	return [
		`=?utf-8?B?${base64}?=`,
		`=?UTF-8?B?${base64}?=`,
		`=?utf-8?b?${base64}?=`,
		`=?UTF-8?b?${base64}?=`,
		`=?utf-8?Q?${quotedPrintable}?=`,
		`=?UTF-8?Q?${quotedPrintable}?=`,
		`=?utf-8?q?${quotedPrintable}?=`,
		`=?UTF-8?q?${quotedPrintable}?=`,
	];
}

function extractEmails(value: string | undefined) {
	return value?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
}

function extractFormattedNames(value: string | undefined) {
	if (!value) return [];
	const names: string[] = [];
	for (const line of value.split(/\r?\n/)) {
		const match = /^"(.+)"\s*<[^>]*>$/.exec(line.trim());
		if (match?.[1]) names.push(match[1]);
	}
	return names;
}

const DELIVERY_RECIPIENT_HEADERS = new Set([
	"to",
	"cc",
	"bcc",
	"delivered-to",
	"x-original-to",
	"x-delivered-to",
	"envelope-to",
	"x-envelope-to",
	"x-forwarded-to",
	"x-rcpt-to",
	"original-recipient",
	"final-recipient",
]);

function extractDeliveryHeaderEmails(eml: string | undefined, senderAddress?: string) {
	if (!eml) return [];
	const headerEnd = eml.search(/\r?\n\r?\n/);
	const rawHeaders = (headerEnd >= 0 ? eml.slice(0, headerEnd) : eml).replace(/\r?\n[ \t]+/g, " ");
	const senderLower = senderAddress?.trim().toLowerCase();
	const found: string[] = [];

	for (const line of rawHeaders.split(/\r?\n/)) {
		const colonIndex = line.indexOf(":");
		if (colonIndex <= 0) continue;
		const key = line.slice(0, colonIndex).trim().toLowerCase();
		const value = line.slice(colonIndex + 1);
		if (DELIVERY_RECIPIENT_HEADERS.has(key)) {
			found.push(...extractEmails(value));
		} else if (key === "received" || key === "x-received") {
			for (const match of value.matchAll(/\bfor\s+<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/gi)) {
				if (match[1]) found.push(match[1]);
			}
		}
	}

	return found.filter((email) => {
		const lower = email.toLowerCase();
		return lower !== senderLower && !lower.endsWith("@phishing.support");
	});
}

function redactionTerms(mail: MailData) {
	const hopRecipients =
		mail.headers?.routing?.totalHops?.flatMap((hop) =>
			typeof hop?.for === "string" ? extractEmails(hop.for) : [],
		) ?? [];

	return Array.from(
		new Set(
			[
				mail.to_object?.address,
				mail.to_object?.name,
				...extractEmails(mail.to),
				...extractEmails(mail.cc),
				...extractEmails(mail.bcc),
				...extractFormattedNames(mail.to),
				...extractFormattedNames(mail.cc),
				...extractFormattedNames(mail.bcc),
				...hopRecipients,
				...extractDeliveryHeaderEmails(mail.eml, mail.from_object?.address),
			]
				.map((x) => x?.trim())
				.filter(
					(x): x is string =>
						x !== undefined &&
						x.length > 3 &&
						x.toLowerCase() !== "[redacted]" &&
						x.toLowerCase() !== "redacted",
				),
		),
	);
}

function emailRedactionVariants(email: string): Array<{ text: string; caseSensitive?: boolean }> {
	const atIndex = email.lastIndexOf("@");
	const local = atIndex > 0 ? email.slice(0, atIndex) : "";
	const domain = atIndex > 0 ? email.slice(atIndex + 1) : "";
	const base64 = Buffer.from(email, "utf-8").toString("base64");
	const base64Unpadded = base64.replace(/=+$/, "");
	const base64Url = Buffer.from(email, "utf-8").toString("base64url");
	const verpAndEncoded =
		local && domain
			? [
					`${local}=3D${domain}`,
					`${local}=3d${domain}`,
					`${domain}=3D${local}`,
					`${domain}=3d${local}`,
					`${local}=${domain}`,
					`${domain}=${local}`,
					`${local}=40${domain}`,
					`${local}%40${domain}`,
				]
			: [];
	return [
		...mimeEncodedWordVariants(email).map((text) => ({ text })),
		{ text: email },
		...verpAndEncoded.map((text) => ({ text })),
		{ text: encodeURIComponent(email) },
		...(base64Unpadded.length >= 8
			? [
					{ text: base64, caseSensitive: true },
					{ text: base64Url, caseSensitive: true },
					{ text: base64Unpadded, caseSensitive: true },
				]
			: []),
	];
}

function redactString(value: string, terms: string[]) {
	let cleaned = value;
	for (const term of terms) {
		if (term.includes("@")) {
			for (const variant of emailRedactionVariants(term)) {
				if (!variant.text) continue;
				const escaped = escapeRegExp(variant.text);
				cleaned = cleaned.replace(new RegExp(escaped, variant.caseSensitive ? "g" : "gi"), "[redacted]");
			}
		} else {
			const qpBody = quotedPrintableEncodedWord(term).replaceAll("_", " ");
			const escapedQuoted = term.replaceAll(/([\\()"'])/g, "\\$1");
			const directVariants = [
				...mimeEncodedWordVariants(term),
				...(qpBody !== term ? [qpBody] : []),
				...(escapedQuoted !== term ? [escapedQuoted] : []),
			];
			for (const variant of directVariants) {
				if (!variant) continue;
				const escaped = escapeRegExp(variant);
				cleaned = cleaned.replace(new RegExp(escaped, "gi"), "[redacted]");
			}
			const escaped = escapeRegExp(term);
			cleaned = cleaned.replace(new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_])`, "giu"), "$1[redacted]");
		}
	}
	return cleaned;
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
		return redactString(node, info);
	} else {
		return node;
	}
}

export function cleanPrivateInformation(mail: MailData) {
	return recursiveClean(mail, redactionTerms(mail)) as MailData;
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

export async function analyzeMail(
	emlContent: string,
	stream_id: bigint,
	options: { reuseEvidenceArtifacts?: boolean } = {}
) {
	try {
		const originalMail = await parseMail(emlContent);
		const mail = cleanPrivateInformation(originalMail);

		await emitStep(stream_id, "start", 0);
		await SubmissionsEntity.update(stream_id, { status: "running", data: { kind: "email", email: mail } });

		let screenshotPng: Buffer | undefined;
		if (options.reuseEvidenceArtifacts) {
			const stored = (await ArtifactsEntity.listForSubmission(stream_id)).find((artifact) => artifact.kind === "screenshot");
			screenshotPng = stored ? (await ArtifactsEntity.get(stored.id))?.blob : undefined;
		} else {
			try {
				const image = await getMailImage(mail);
				screenshotPng = image;
				await ArtifactsEntity.saveBuffer({
					submissionId: stream_id,
					name: "mail.png",
					kind: "screenshot",
					mimeType: "image/png",
					buffer: image,
				});
			} catch {
				// Screenshot generation is supplementary evidence and must not block analysis.
			}
		}

		if (!options.reuseEvidenceArtifacts) {
			await ArtifactsEntity.saveBuffer({
				submissionId: stream_id,
				name: "mail.eml",
				kind: "eml",
				mimeType: "message/rfc822",
				buffer: Buffer.from(mail.eml, "utf-8"),
			});
		}

		await emitStep(stream_id, "analysis_run", 30);

		const { result: analysis } = await runStreamedAnalysisRun({
			submissionId: stream_id,
			analysisKind: "analysis",
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
			analysisKind: "classification",
			options: {
				stream: true,
				model: defaultResponseModel,
				input: [
					{
						role: "system",
						content: `Classify the email from the supplied evidence. Answer {"phishing":true} if the email is phishing, credential theft, payment fraud, delivery-scam abuse, malicious, or strongly impersonates a trusted brand. Answer {"phishing":false} only when the evidence supports a legitimate/benign email. Do not treat SPF/DKIM/DMARC pass as proof of legitimacy when the authenticated domain itself is unrelated to the impersonated brand. Provide no other text.`,
					},
					{
						role: "user",
						content: `Evidence:
${buildMailEvidence(mail, analysis.output_text)}`,
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
		if (typeof phishing !== "boolean") {
			throw new Error(`Failed to classify email phishing result: ${structuredResponse.output_text}`);
		}

		const date = mail.date ? new Date(mail.date).toLocaleString("en-US", { timeZone: "UTC" }) : undefined;
		const submissionSubject = `"${mail.from_object?.name || mail.from_object?.address}" ${date ? "from " + date : ""}`;
		let to = originalMail.to_object?.address;

		if (to?.endsWith("@phishing.support")) {
			to = undefined;
		}

		if (phishing) {
			await emitStep(stream_id, "reporting", 90);
			const submission = await SubmissionsEntity.get(stream_id);
			const reporter = {
				reporterIp: submission?.reporterIp ?? undefined,
				reporterCountry: submission?.reporterCountry ?? undefined,
				reporterHeaders: submission?.reporterHeaders ?? undefined,
			};
			await reportConfirmedEmailPhishing({
				submissionId: stream_id,
				analysisText: analysis.output_text,
				redactedEml: mail.eml,
				sendingIp: mail.headers.routing.originatingIp,
				screenshotPng,
				reporter,
			});
			// Every linked page is analyzed and, if confirmed, reported as its own website.
			for (const link of getMailLinks(mail)) {
				if (!URL.canParse(link.href)) continue;
				const url = new URL(link.href);
				if (url.protocol !== "http:" && url.protocol !== "https:") continue;
				createWebsiteSubmission({ url: url.toString(), source: `email:${stream_id.toString()}`, ...reporter }).catch(console.error);
			}

			await SubmissionsEntity.update(stream_id, { status: "reported", info: undefined });
			var subject = `Phishing Reported - ${submissionSubject}`;
			var body = [
				`Thank you very much for your report!`,
				"",
				`We have analyzed the email you provided and determined that it is indeed a phishing attempt.`,
				"",
				`Your submission is being reported to the email providers and hosting services involved.`,
				`You can follow each report at: ${serviceIdentity.url}/submissions/${stream_id}`,
				"",
				`Thank you for helping to combat phishing!`,
				`Your ${serviceIdentity.name} Team`,
			].join("\n");
		} else {
			await markSubmissionInvalid(stream_id);

			var subject = `Not Phishing - ${submissionSubject}`;
			var body = [
				`Thank you for your report. We analyzed the email you provided and determined that it is not a phishing attempt.`,
				"",
				`As a result, we have marked this submission as invalid.`,
				`You can view details at: ${serviceIdentity.url}/submissions/${stream_id}`,
				"",
				`If you believe this is an error, please feel free to reach out to us at ${serviceIdentity.mailbox}.`,
				"",
				`Thank you for helping to combat phishing!`,
				`Your ${serviceIdentity.name} Team`,
			].join("\n");
		}

		// Send a brief notification back to the reporter with the result and a link
		try {
			const from = `${serviceIdentity.name} <${smtpSender()}>`;
			console.log(
				`Sending reporter notification email to ${to} from ${from} for submission ${stream_id}. Subject: ${subject} Body: ${body}`
			);
			if (to && subject && body) {
				await smtpTransport()?.sendMail({ from, to, subject, text: body });
			}
		} catch (err) {
			console.error("Failed to send reporter notification email:", err);
		}

		await emitStep(stream_id, "completed", 100);
	} catch (error) {
		console.error("Email analysis failed:", error);
		await SubmissionsEntity.update(stream_id, { status: "failed", info: errorText(error) });
		await emitStep(stream_id, "failed", 100);
	}
}
