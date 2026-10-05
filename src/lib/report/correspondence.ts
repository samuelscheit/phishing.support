import crypto from "node:crypto";

import MailAddressParser from "nodemailer/lib/addressparser";
import { parse } from "node-html-parser";

const HEADER_BREAK_RE = /[\r\n\u0000]/;
const CONTROL_CHAR_RE = /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const MESSAGE_ID_TOKEN_RE = /<\s*([^<>\s]+)\s*>/g;
const REPLY_TOKEN_RE = /^[a-f0-9]{32}$/;

export type ReplyIdentity = {
	replyAddress: string;
	replyToken: string;
};

export type IncomingMessageKind = "reply" | "auto_reply" | "bounce";

/** Reject data that could turn an email field into additional MIME headers. */
export function assertSafeHeaderValue(name: string, value: string | undefined | null): string {
	if (value === undefined || value === null) return "";
	if (HEADER_BREAK_RE.test(value) || CONTROL_CHAR_RE.test(value)) throw new Error(`${name} contains an invalid control character.`);
	return value.trim();
}

function unfoldHeader(value: string): string {
	return value.replace(/\r?\n[ \t]+/g, " ").trim();
}

/** Reject unbalanced angle-address delimiters before a permissive parser repairs them. */
function hasBalancedAngleAddressSyntax(value: string): boolean {
	let quoted = false;
	let escaped = false;
	let insideAngleAddress = false;

	for (const character of value) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quoted && character === "\\") {
			escaped = true;
			continue;
		}
		if (character === '"') {
			quoted = !quoted;
			continue;
		}
		if (quoted) continue;

		if (character === "<") {
			if (insideAngleAddress) return false;
			insideAngleAddress = true;
			continue;
		}
		if (character === ">") {
			if (!insideAngleAddress) return false;
			insideAngleAddress = false;
		}
	}

	return !quoted && !insideAngleAddress;
}

/**
 * The outbound recipient field accepts an ordinary comma-separated mailbox
 * list, not RFC group syntax or an embedded message header. Nodemailer's
 * permissive parser treats `Bcc: person@example.test` as an address list, so
 * reject those forms before they can change where an AI-produced report goes.
 */
function hasSafeRecipientListSyntax(value: string): boolean {
	if (!hasBalancedAngleAddressSyntax(value)) return false;

	let quoted = false;
	let escaped = false;

	for (const character of value) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quoted && character === "\\") {
			escaped = true;
			continue;
		}
		if (character === '"') {
			quoted = !quoted;
			continue;
		}
		if (quoted) continue;

		// Colons and semicolons introduce RFC address groups and are also how
		// a bare `Bcc:`/`Cc:` header can be smuggled into a permissive parser.
		if (character === ":" || character === ";") return false;
	}

	return !quoted;
}

/**
 * Normalizes a single mailbox for exact matching. This deliberately does not
 * perform provider-specific transformations such as Gmail dot stripping.
 */
export function normalizeEmailAddress(value: string | undefined | null): string | undefined {
	if (!value) return undefined;
	const candidate = unfoldHeader(value).trim();
	if (!hasBalancedAngleAddressSyntax(candidate)) return undefined;
	const direct = (
		candidate.startsWith("<") && candidate.endsWith(">")
			? candidate.slice(1, -1)
			: candidate
	).toLowerCase();
	if (EMAIL_RE.test(direct)) return direct;

	try {
		const parsed = MailAddressParser(candidate, { flatten: true }) as Array<{ address?: string }>;
		if (parsed.length === 1) {
			const parsedAddress = parsed[0]?.address?.trim().toLowerCase();
			if (parsedAddress && EMAIL_RE.test(parsedAddress)) return parsedAddress;
		}
	} catch {
		// Invalid address syntax remains unmatched.
	}

	return undefined;
}

/** Extracts mailbox addresses from display names, folded headers, or bare addresses. */
export function extractNormalizedAddresses(value: string | string[] | undefined | null): string[] {
	const inputs = Array.isArray(value) ? value : value ? [value] : [];
	const addresses = new Set<string>();

	for (const input of inputs) {
		if (!input) continue;
		const unfolded = unfoldHeader(input);

		try {
			const parsed = MailAddressParser(unfolded, { flatten: true }) as Array<{ address?: string }>;
			for (const item of parsed) {
				const address = normalizeEmailAddress(item.address);
				if (address) addresses.add(address);
			}
		} catch {
			// Fall through to the conservative mailbox scan below.
		}

		for (const match of unfolded.matchAll(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/gi)) {
			const address = normalizeEmailAddress(match[0]);
			if (address) addresses.add(address);
		}
	}

	return [...addresses];
}

/** Validates an AI-generated recipient field before it can be used in a MIME header. */
export function normalizeReportRecipients(value: string): string[] {
	const safeValue = assertSafeHeaderValue("Report recipient", value);
	if (!hasSafeRecipientListSyntax(safeValue)) {
		throw new Error("Report recipient contains unsupported header or mailbox-list syntax.");
	}
	const parsed = MailAddressParser(safeValue, { flatten: true }) as Array<{ address?: string }>;
	if (parsed.length === 0 || parsed.some((item) => !normalizeEmailAddress(item.address))) {
		throw new Error("Report recipient contains malformed mailbox syntax.");
	}
	const recipients = Array.from(
		new Set(
			parsed
				.map((item) => normalizeEmailAddress(item.address))
				.filter((address): address is string => Boolean(address)),
		),
	);
	// Do not let addressparser discard a bare mailbox while accepting another
	// one. For example, it interprets `one@example.test cc <two@example.test>`
	// as only `two@example.test`; that is neither an unambiguous address list
	// nor a safe AI-generated destination. A conservative raw-token comparison
	// makes such malformed lists fail closed.
	const declaredMailboxTokens = extractNormalizedAddresses(safeValue);
	if (
		declaredMailboxTokens.length !== recipients.length ||
		declaredMailboxTokens.some((address) => !recipients.includes(address))
	) {
		throw new Error("Report recipient contains ambiguous mailbox syntax.");
	}
	if (recipients.length === 0) throw new Error("Report recipient does not contain a valid email address.");
	return recipients;
}

export function normalizeDomain(value: string | undefined | null): string | undefined {
	if (!value || HEADER_BREAK_RE.test(value)) return undefined;
	const domain = value.trim().replace(/\.$/, "").toLowerCase();
	return DOMAIN_RE.test(domain) ? domain : undefined;
}

export function getReportReplyDomain(): string {
	const domain = normalizeDomain(process.env.REPORT_REPLY_DOMAIN);
	if (!domain) {
		throw new Error("REPORT_REPLY_DOMAIN must be a valid DNS domain before sending correspondence-enabled reports.");
	}
	return domain;
}

/**
 * Resolves the reply domain only when it is wired to the mailbox that ingests
 * correspondence. Sending without this check would create Reply-To addresses
 * that cannot be assigned back to their report threads.
 */
export function getConfiguredReportReplyDomain(): string {
	const replyDomain = getReportReplyDomain();
	const intakeAddress = process.env.IMAP_LISTEN_ADDRESS;
	if (!intakeAddress) {
		throw new Error("IMAP_LISTEN_ADDRESS must be configured before sending correspondence-enabled reports.");
	}
	validateReplyDomainForIntake(replyDomain, intakeAddress);
	return replyDomain;
}

export function validateReplyDomainForIntake(replyDomain: string, intakeAddress: string): void {
	const normalizedReplyDomain = normalizeDomain(replyDomain);
	const normalizedIntake = normalizeEmailAddress(intakeAddress);
	if (!normalizedReplyDomain) throw new Error("REPORT_REPLY_DOMAIN must be a valid DNS domain.");
	if (!normalizedIntake) throw new Error("IMAP_LISTEN_ADDRESS must be a valid mailbox address.");
	if (normalizedIntake.slice(normalizedIntake.lastIndexOf("@") + 1) !== normalizedReplyDomain) {
		throw new Error("REPORT_REPLY_DOMAIN must match the domain of IMAP_LISTEN_ADDRESS so generated replies reach the monitored mailbox.");
	}
}

/** Generates a per-report opaque Reply-To identity from 128 bits of randomness. */
export function createReplyIdentity(domain = getReportReplyDomain()): ReplyIdentity {
	const normalizedDomain = normalizeDomain(domain);
	if (!normalizedDomain) throw new Error("Reply domain must be a valid DNS domain.");
	const replyToken = crypto.randomBytes(16).toString("hex");
	return {
		replyToken,
		replyAddress: `case-${replyToken}@${normalizedDomain}`,
	};
}

/** Generates an explicit RFC 5322 Message-ID without exposing submission data. */
export function createRfcMessageId(domain = getReportReplyDomain()): string {
	const normalizedDomain = normalizeDomain(domain);
	if (!normalizedDomain) throw new Error("Message-ID domain must be a valid DNS domain.");
	return `<report-${crypto.randomBytes(16).toString("hex")}@${normalizedDomain}>`;
}

export function normalizeMessageId(value: string | undefined | null): string | undefined {
	if (!value || HEADER_BREAK_RE.test(value.replace(/\r?\n[ \t]+/g, ""))) return undefined;
	const unfolded = unfoldHeader(value);
	const matches = [...unfolded.matchAll(MESSAGE_ID_TOKEN_RE)];
	const token = matches[0]?.[1] ?? (unfolded.match(/^[^<>\s@]+@[^<>\s@]+$/)?.[0] || undefined);
	if (!token || !/^[^<>\s@]+@[^<>\s@]+$/.test(token)) return undefined;
	return `<${token.toLowerCase()}>`;
}

export function parseMessageIdList(value: string | readonly string[] | undefined | null): string[] {
	const values = Array.isArray(value) ? value : value ? [value] : [];
	const ids = new Set<string>();

	for (const raw of values) {
		if (!raw) continue;
		const unfolded = unfoldHeader(raw);
		const matches = [...unfolded.matchAll(MESSAGE_ID_TOKEN_RE)];
		if (matches.length > 0) {
			for (const match of matches) {
				const id = normalizeMessageId(`<${match[1]}>`);
				if (id) ids.add(id);
			}
		} else {
			const id = normalizeMessageId(unfolded);
			if (id) ids.add(id);
		}
	}

	return [...ids];
}

export function normalizeDiagnosticThreadToken(value: string | undefined | null): string | undefined {
	if (!value) return undefined;
	const token = unfoldHeader(value).trim().toLowerCase();
	return REPLY_TOKEN_RE.test(token) ? token : undefined;
}

function normalizedHeaderValue(headers: Map<string, unknown> | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const value = headers.get(name.toLowerCase());
	if (Array.isArray(value)) return value.map(String).join(" ");
	if (value && typeof value === "object") {
		const candidate = value as { value?: unknown; text?: unknown };
		if (typeof candidate.value === "string") return candidate.value;
		if (typeof candidate.text === "string") return candidate.text;
	}
	return value === undefined || value === null ? undefined : String(value);
}

/** Classifies correspondence without trusting a subject line for thread matching. */
export function classifyIncomingMessage(params: {
	from?: string | null;
	subject?: string | null;
	contentType?: string | null;
	headers?: Map<string, unknown>;
}): IncomingMessageKind {
	const from = params.from?.toLowerCase() ?? "";
	const subject = params.subject?.toLowerCase() ?? "";
	const contentType = params.contentType?.toLowerCase() ?? "";
	const autoSubmitted = normalizedHeaderValue(params.headers, "auto-submitted")?.toLowerCase() ?? "";
	const precedence = normalizedHeaderValue(params.headers, "precedence")?.toLowerCase() ?? "";
	const xAutoResponse = [
		normalizedHeaderValue(params.headers, "x-autoreply"),
		normalizedHeaderValue(params.headers, "x-autorespond"),
		normalizedHeaderValue(params.headers, "x-auto-response-suppress"),
	].filter(Boolean);

	const isBounce =
		contentType.includes("multipart/report") ||
		contentType.includes("message/delivery-status") ||
		/mailer-daemon|postmaster/.test(from) ||
		/(delivery[ -]?(?:status|failure|notification)|undeliverable|mail delivery failed|failure notice)/.test(subject);
	if (isBounce) return "bounce";

	const isAutoReply =
		(autoSubmitted.length > 0 && autoSubmitted !== "no") ||
		xAutoResponse.length > 0 ||
		precedence === "bulk" ||
		/(automatic reply|auto(?:matic)?[ -]?reply|out of (?:the )?office|vacation(?: responder)?)/.test(subject);
	return isAutoReply ? "auto_reply" : "reply";
}

/**
 * Makes a stored HTML email inert before it reaches the browser. The UI still
 * renders this output in a sandboxed, no-referrer iframe as defense in depth.
 */
export function sanitizeCorrespondenceHtml(rawHtml: string | undefined | null): string | null {
	if (!rawHtml) return null;
	const root = parse(rawHtml);

	for (const node of root.querySelectorAll("script, style, form, iframe, object, embed, applet, base, meta, link, svg, math, img, picture, video, audio, source, track, input, button, textarea, select, option")) {
		node.remove();
	}

	for (const node of root.querySelectorAll("*")) {
		for (const attribute of Object.keys(node.attributes)) {
			const name = attribute.toLowerCase();
			const value = node.getAttribute(attribute) ?? "";
			if (
				name.startsWith("on") ||
				["src", "srcset", "poster", "background", "action", "formaction", "xlink:href", "href"].includes(name) ||
				(name === "style" && /(?:url\s*\(|expression\s*\(|@import)/i.test(value))
			) {
				node.removeAttribute(attribute);
			}
		}
	}

	return root.toString();
}
