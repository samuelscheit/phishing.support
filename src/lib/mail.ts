import { simpleParser, type AddressObject } from "mailparser";
import fs from "fs";
import path from "path";
import { config } from "dotenv";
import { parse } from "node-html-parser";
import { launch } from "puppeteer-core";
import { tmpdir } from "os";
import { getBrowser, getBrowserPage } from "./browser/";
import is_ip_private from "private-ip";
import { analyzeSMTPHeadersFromRaw } from "@bernierllc/smtp-analyzer";
import { MailData } from "./mail_ai";
import { sleep } from "./utils";
import MailAddressParser from "nodemailer/lib/addressparser";

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

export function getMailLinks(result: MailData) {
	try {
		if (!result.html) return [];

		const doc = parse(result.html);

		return doc.querySelectorAll("a").map((link) => {
			const href = link.getAttribute("href");

			return {
				href: href || "",
				text: link.text.trim(),
			};
		});
	} catch (error) {
		console.error("Error processing HTML content:", error);
	}
	return [];
}

export async function getMailImage(result: MailData) {
	const browser = await getBrowser();
	const page = await browser.newPage();

	try {
		if (!result.html) throw new Error("No HTML content found");

		await page.setViewport({ width: 1080, height: 720 });

		await page.setContent(result.html, {
			waitUntil: "domcontentloaded",
		});

		await page.setJavaScriptEnabled(false);

		await page.waitForNetworkIdle();

		const screenshot = await page.screenshot({
			fullPage: true,
			captureBeyondViewport: true,
			type: "png",
		});
		await browser.close();
		return Buffer.from(screenshot);
	} catch (error) {
		await browser.close();

		console.error("Error processing HTML content:", error);
		throw error;
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
	// raw: string;
};

function parseReceived(lines: string[]): ReceivedHop[] {
	return lines.map((line) => {
		const compact = line.replace(/\s+/g, " ").trim();
		const fromMatch = compact.match(/\bfrom\s+([^\s]+)\b/i);
		const byMatch = compact.match(/\bby\s+([^\s]+)\b/i);
		const withMatch = compact.match(/\bwith\s+([^\s;]+)\b/i);
		const ipMatch = compact.match(/\[([0-9a-fA-F:.]+)\]/);

		return {
			fromHost: fromMatch?.[1] ?? "",
			fromIp: ipMatch?.[1] ?? "",
			byHost: byMatch?.[1] ?? "",
			withProto: withMatch?.[1] ?? "",
			// raw: compact,
		};
	});
}

export function analyzeHeaders(headers: string) {
	const result = analyzeSMTPHeadersFromRaw(headers);
	if (!result.success || !result.data) throw new Error(result.error);

	const headersMap = new Map();

	const headerLines = headers.split(/\r?\n/);
	headerLines.forEach((line) => {
		const sepIndex = line.indexOf(":");
		if (sepIndex > 0) {
			const key = line.slice(0, sepIndex).trim().toLowerCase();
			const value = line.slice(sepIndex + 1).trim();
			if (headersMap.has(key)) {
				const existing = headersMap.get(key);
				if (Array.isArray(existing)) {
					existing.push(value);
					headersMap.set(key, existing);
				} else {
					headersMap.set(key, [existing, value]);
				}
			} else {
				headersMap.set(key, value);
			}
		}
	});

	const fromHeader = getHeaderValues(headersMap, "from");
	const from = fromHeader?.length > 0 && MailAddressParser(fromHeader[0], { flatten: true });

	const dmarcPolicy = getHeaderValues(headersMap, "x-dmarc-policy");
	const dmarcInfo = getHeaderValues(headersMap, "x-dmarc-info");
	const arcInfo = getHeaderValues(headersMap, "x-arc-info");

	const hops = parseReceived(result.data.routing.totalHops.map((x) => x.raw));
	const sourceHop = [...hops].find((hop) => hop.fromIp && !is_ip_private(hop.fromIp)) || [...hops].reverse().find((hop) => hop.fromIp);

	result.data.routing.totalHops.forEach((x) => {
		// @ts-ignore
		delete x.raw;
	});
	delete result.data.authentication.rawHeader;
	const signature = result.data.securityHeaders.dkimSignature;
	delete result.data.securityHeaders.receivedSpf;
	delete result.data.securityHeaders.dkimSignature;

	let originatingIp = result.data.routing.originatingIp;
	let originatingServer = result.data.routing.originatingServer;

	if (sourceHop) {
		originatingIp = sourceHop.fromIp;
		originatingServer = sourceHop.fromHost;
	} else if (from && from[0].address && !originatingServer) {
		originatingServer = from[0].address.split("@")[1];
	}

	return {
		authentication: {
			...result.data.authentication,
			...result.data.securityHeaders,
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
			originatingIp,
			originatingServer,
		},
	};

	// return {
	// 	identifiers: {
	// 		returnPath: getHeaderValues(headers, "return-path")[0] || "",
	// 		messageId: getHeaderValues(headers, "message-id")[0] || "",
	// 		subject: getHeaderValues(headers, "subject")[0] || "",
	// 		date: getHeaderValues(headers, "date")[0] || "",
	// 	},
	// 	client: {
	// 		mailer: getHeaderValues(headers, "x-mailer")[0] || "",
	// 	},
	// 	auth: {
	// 		results: parseAuthResults(authResults),
	// 		receivedSpf: receivedSpf[0] || "",
	// 		dmarcPolicy: dmarcPolicy[0] || "",
	// 		dmarcInfo: dmarcInfo[0] || "",
	// 	},
	// 	received: {
	// 		hops,
	// 		sourceIp: sourceHop?.fromIp || "",
	// 		sourceHost: sourceHop?.fromHost || "",
	// 	},
	// };
}
