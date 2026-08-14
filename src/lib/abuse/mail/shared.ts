import type { ParsedMail } from "mailparser";

const MESSAGE_ID = /^<[^<>\s@]+@[^<>\s@]+>$/;

export function attachmentFilename(value: string): string {
	const safe = value.replace(/[\u0000-\u001f\u007f\\/\r\n]/g, "_").trim().slice(0, 180);
	return safe || "evidence";
}

export function inboundBodyText(parsed: ParsedMail): string {
	return [parsed.text ?? "", typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : ""].join(" ").replace(/\s+/g, " ").trim();
}

export function isRfcMessageId(value: string | undefined): value is string {
	return Boolean(value && MESSAGE_ID.test(value));
}

/** Extract exactly one conventional numeric verification code from untrusted mail. */
export function extractUnambiguousVerificationCode(text: string): string | undefined {
	const candidates = [...text.matchAll(/\b(\d{6,8})\b/g)].map((match) => match[1]);
	return candidates.length === 1 ? candidates[0] : undefined;
}
