import { simpleParser, type AddressObject, type EmailAddress, type ParsedMail } from "mailparser";

import type { FetchedAbuseMail } from "./types";

export function normalizeMailbox(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const candidate = value.trim().replace(/^<|>$/g, "").toLowerCase();
	if (candidate.length > 320 || /[\r\n\0]/.test(candidate)) return undefined;
	return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(candidate)
		? candidate
		: undefined;
}

export function normalizeMessageId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const candidate = value.trim().replace(/^<|>$/g, "");
	if (!candidate || /[\r\n\s<>]/.test(candidate) || !candidate.includes("@")) return undefined;
	return `<${candidate}>`;
}

export function headerStrings(parsed: ParsedMail, name: string): string[] {
	const wanted = name.toLowerCase();
	const fromLines = parsed.headerLines
		.filter((line) => line.key.toLowerCase() === wanted)
		.map((line) => line.line.slice(line.line.indexOf(":") + 1).replace(/\r?\n[ \t]+/g, " ").trim());
	if (fromLines.length) return fromLines;
	const value = parsed.headers.get(wanted);
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap((item) => (typeof item === "string" ? [item] : []));
	return [];
}

export function flattenAddresses(value: AddressObject | AddressObject[] | undefined): EmailAddress[] {
	const objects = Array.isArray(value) ? value : value ? [value] : [];
	const result: EmailAddress[] = [];
	const visit = (entry: EmailAddress) => {
		result.push(entry);
		for (const nested of entry.group ?? []) visit(nested);
	};
	for (const object of objects) for (const entry of object.value ?? []) visit(entry);
	return result;
}

function normalizedMailboxes(values: string[]): string[] {
	return values
		.flatMap((value) => value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])
		.map(normalizeMailbox)
		.filter((value): value is string => Boolean(value));
}

function addressField(parsed: ParsedMail, field: "to" | "cc" | "bcc"): string[] {
	const parsedAddresses = flattenAddresses(parsed[field]).map((entry) => normalizeMailbox(entry.address)).filter((value): value is string => Boolean(value));
	const headerAddresses = normalizedMailboxes(headerStrings(parsed, field));
	return [...new Set([...parsedAddresses, ...headerAddresses])];
}

export function recipients(parsed: ParsedMail, message: FetchedAbuseMail): string[] {
	const envelope = [...(message.envelope?.to ?? []), ...(message.envelope?.cc ?? []), ...(message.envelope?.bcc ?? [])]
		.map((entry) => normalizeMailbox(entry.address))
		.filter((value): value is string => Boolean(value));
	const delivered = normalizedMailboxes(["delivered-to", "x-original-to", "x-forwarded-to"].flatMap((name) => headerStrings(parsed, name)));
	return [...new Set([...addressField(parsed, "to"), ...addressField(parsed, "cc"), ...addressField(parsed, "bcc"), ...delivered, ...envelope])];
}

export function references(parsed: ParsedMail): string[] {
	const values = [...(parsed.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : []), ...headerStrings(parsed, "references")];
	return [...new Set(values.flatMap((value) => value.match(/<[^<>\s]+@[^<>\s]+>/g) ?? []).map(normalizeMessageId).filter((value): value is string => Boolean(value)))];
}

export function isSeen(flags: FetchedAbuseMail["flags"]): boolean {
	if (!flags) return false;
	if (typeof (flags as { has?: unknown }).has === "function") return (flags as { has(flag: string): boolean }).has("\\Seen");
	return Array.isArray(flags) && flags.includes("\\Seen");
}

export function messageBody(parsed: ParsedMail): string {
	return [parsed.text ?? "", typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : ""].join(" ");
}

export async function parseAbuseMail(raw: Buffer): Promise<ParsedMail> {
	return simpleParser(raw, { skipTextToHtml: true });
}
