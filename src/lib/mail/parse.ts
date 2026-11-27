import { simpleParser, type AddressObject } from "mailparser";
import { parse } from "node-html-parser";
import { getBrowser } from "../browser";
import { analyzeSMTPHeadersFromRaw } from "@bernierllc/smtp-analyzer";
import type { MailData } from "./ai";
import { isPrivateIpAddress } from "../network/ip_address";
import { sleep } from "../util/sleep";
import { squash } from "../util/text";

export function getAddressesText(obj: AddressObject[] | AddressObject | undefined): string {
	if (!obj) return "";

	let addresses: AddressObject[] = [];

	if (Array.isArray(obj)) {
		addresses = obj;
	} else {
		addresses = [obj];
	}

	return addresses.map(getAddressText).join("\n");
}

function getAddressText(obj: AddressObject | undefined): string {
	if (!obj) return "";

	let text = "";

	obj.value.forEach((addr) => {
		text += `"${addr.name}" <${addr.address}>\n`;
	});

	return text.trim();
}

const TEXT_URL_RE = /https?:\/\/[^\s"'<>]+/gi;
/** Sentence punctuation that follows a URL written in running text. */
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}]+$/;

/**
 * The web pages a message links to: every anchor in its HTML part and every
 * URL written in its text, which plain-text and multipart mails rely on. Image
 * and stylesheet URLs are deliberately excluded; they are not destinations.
 */
export function getMailWebsiteUrls(mail: Pick<MailData, "html" | "text">): string[] {
	const candidates = [
		...(mail.html ? parse(mail.html).querySelectorAll("a").map((link) => link.getAttribute("href")?.trim() ?? "") : []),
		...(mail.text.match(TEXT_URL_RE) ?? []).map((url) => url.replace(TRAILING_PUNCTUATION_RE, "")),
	];
	const urls = new Set<string>();
	for (const candidate of candidates) {
		if (!URL.canParse(candidate)) continue;
		const url = new URL(candidate);
		if (url.protocol === "http:" || url.protocol === "https:") urls.add(url.toString());
	}
	return [...urls];
}

export async function getMailImage(result: MailData) {
	if (!result.html) throw new Error("No HTML content found");
	const browser = await getBrowser();

	try {
		const page = await browser.newPage();
		// Scripts in a reported mail must never run, so they are off before the content is set.
		await page.setJavaScriptEnabled(false);
		await page.setViewport({ width: 1080, height: 720 });
		await page.setContent(result.html, { waitUntil: "domcontentloaded" });
		await page.waitForNetworkIdle();

		const screenshot = await page.screenshot({
			fullPage: true,
			captureBeyondViewport: true,
			type: "png",
		});
		return Buffer.from(screenshot);
	} finally {
		await browser.close();
	}
}

function normalizeHeaderValue(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	if (Array.isArray(value)) {
		return value.flatMap((entry) => normalizeHeaderValue(entry));
	}
	if (typeof value === "string") return [value];
	if (typeof value === "number" || typeof value === "boolean") return [String(value)];
	if (typeof value === "object") {
		const obj = value as Record<string, unknown>;
		if (typeof obj.text === "string") return [obj.text];
		if (typeof obj.value === "string") return [obj.value];
	}
	return [String(value)];
}

type HeaderMap = Map<string, string | string[]>;

function getHeaderValues(headers: HeaderMap, key: string): string[] {
	const value = headers.get(key);
	return normalizeHeaderValue(value);
}

type ReceivedHop = {
	fromHost: string;
	fromIp: string;
	byHost: string;
	withProto: string;
};

function parseReceived(lines: string[]): ReceivedHop[] {
	return lines.map((line) => {
		const compact = squash(line);
		const fromMatch = compact.match(/\bfrom\s+([^\s]+)\b/i);
		const byMatch = compact.match(/\bby\s+([^\s]+)\b/i);
		const withMatch = compact.match(/\bwith\s+([^\s;]+)\b/i);
		const ipMatch = compact.match(/\[([0-9a-fA-F:.]+)\]/);

		return {
			fromHost: fromMatch?.[1] ?? "",
			fromIp: ipMatch?.[1] ?? "",
			byHost: byMatch?.[1] ?? "",
			withProto: withMatch?.[1] ?? "",
		};
	});
}

export function analyzeHeaders(headers: string) {
	const result = analyzeSMTPHeadersFromRaw(headers);
	if (!result.success || !result.data) throw new Error(result.error);

	const headersMap: HeaderMap = new Map();

	const headerLines = headers.split(/\r?\n/);
	headerLines.forEach((line) => {
		const sepIndex = line.indexOf(":");
		if (sepIndex > 0) {
			const key = line.slice(0, sepIndex).trim().toLowerCase();
			const value = line.slice(sepIndex + 1).trim();
			const existing = headersMap.get(key);
			headersMap.set(key, existing === undefined ? value : [existing, value].flat());
		}
	});

	const dmarcPolicy = getHeaderValues(headersMap, "x-dmarc-policy");
	const dmarcInfo = getHeaderValues(headersMap, "x-dmarc-info");
	const arcInfo = getHeaderValues(headersMap, "x-arc-info");

	const hops = parseReceived(result.data.routing.totalHops.map((x) => x.raw));
	// The RFC 5322 From field is sender-controlled and says nothing about the
	// SMTP host that delivered the message. Restrict origin attribution to
	// Received-chain evidence so downstream infrastructure lookups do not
	// mistake an arbitrary displayed sender domain for a transport endpoint.
	const sourceHop =
		[...hops].find((hop) => hop.fromIp && !isPrivateIpAddress(hop.fromIp)) ??
		[...hops].reverse().find((hop) => hop.fromIp) ??
		[...hops].reverse().find((hop) => hop.fromHost);

	// Raw hop lines, the raw header block and the SPF/DKIM header values are
	// bulky and already summarised by the parsed fields, so they are dropped.
	const totalHops = result.data.routing.totalHops.map(({ raw, ...hop }) => hop);
	const { rawHeader, ...authentication } = result.data.authentication;
	const { receivedSpf, dkimSignature: signature, ...securityHeaders } = result.data.securityHeaders;

	const originatingIp = sourceHop?.fromIp || undefined;
	const originatingServer = sourceHop?.fromHost || undefined;

	return {
		authentication: {
			...authentication,
			...securityHeaders,
			dmarc: {
				policy: dmarcPolicy[0] || "",
				info: dmarcInfo[0] || "",
			},
			dkim: {
				...result.data.authentication.dkim,
				signature,
			},
			arc: arcInfo[0] || "",
		},
		routing: {
			...result.data.routing,
			totalHops,
			originatingIp,
			originatingServer,
		},
	};
}
