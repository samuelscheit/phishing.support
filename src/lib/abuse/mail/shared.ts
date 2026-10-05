import type { ParsedMail } from "mailparser";

const MESSAGE_ID = /^<[^<>\s@]+@[^<>\s@]+>$/;

/**
 * Canonicalize an address only when it is a single mailbox suitable for
 * durable routing and comparison. Display names and malformed headers stay
 * untrusted input; callers that need a list must parse that list first.
 */
export function normalizeMailbox(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const candidate = value.trim().replace(/^<|>$/g, "").toLowerCase();
	if (candidate.length > 320 || /[\r\n\0]/.test(candidate)) return undefined;
	return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(candidate)
		? candidate
		: undefined;
}

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
