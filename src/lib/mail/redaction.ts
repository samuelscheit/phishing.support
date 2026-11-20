import { serviceIdentity } from "../network/service_identity";
import type { MailData } from "./ai";
import { isRecord, type JsonRecord } from "../util/values";

const serviceMailDomain = serviceIdentity.mailbox.slice(serviceIdentity.mailbox.lastIndexOf("@") + 1).toLowerCase();

/** Whether an address belongs to the service itself, so it is not a reporter's private mailbox. */
export function isServiceAddress(address: string): boolean {
	return address.toLowerCase().endsWith(`@${serviceMailDomain}`);
}

/**
 * Removes the reporter's own address and name from a forwarded mail before it
 * is stored, shown or sent to a model or provider. A mail repeats the recipient
 * in many encodings (MIME encoded words, VERP, base64, URL escapes), so every
 * known variant of each recipient term is replaced, not only the plain text.
 */

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

	return found.filter((email) => email.toLowerCase() !== senderLower && !isServiceAddress(email));
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
				const escaped = RegExp.escape(variant.text);
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
				const escaped = RegExp.escape(variant);
				cleaned = cleaned.replace(new RegExp(escaped, "gi"), "[redacted]");
			}
			const escaped = RegExp.escape(term);
			cleaned = cleaned.replace(new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_])`, "giu"), "$1[redacted]");
		}
	}
	return cleaned;
}

/** Redacts every string inside a JSON-like value and drops null and undefined fields. */
function recursiveClean(node: unknown, terms: string[]): unknown {
	if (Array.isArray(node)) return node.map((item) => recursiveClean(item, terms));
	if (typeof node === "string") return redactString(node, terms);
	if (!isRecord(node)) return node;
	const cleaned: JsonRecord = {};
	for (const [key, value] of Object.entries(node)) {
		if (value !== undefined && value !== null) cleaned[key] = recursiveClean(value, terms);
	}
	return cleaned;
}

export function cleanPrivateInformation(mail: MailData) {
	return recursiveClean(mail, redactionTerms(mail)) as MailData;
}

