import { createHash } from "node:crypto";
import { parse } from "node-html-parser";

import type { BrowserIdentity } from "../../browser/page";
import { ArtifactsEntity } from "../../db/entities";
import { buildWebsiteEvidence } from "../../evidence/package";
import type { timestampEvidence } from "../../evidence/timestamp";
import { extractPasteCommands } from "../../malware/paste_commands";
import { fetchThroughPublicRedirects } from "../../network/public_redirects";
import { archiveWebsite, WebsiteCaptureFailedError } from "../../website_archive";
import type { WebsiteDevice } from "../../website_types";
import type { AccountIdentifierExtractor } from "./account_identifiers";

/** A file the answer may attach: the case's evidence, or a screenshot a recheck took. */
export type AttachableFile = { filename: string; mimeType: string; content: Buffer };

/** What the tools need from the case; everything else they find themselves. */
export type DecisionToolContext = {
	submissionId?: bigint;
	caseUrl?: string;
	/** The browser the case's captures presented: the reporter's, or the phone a mobile-only kit asked for. */
	visitor?: BrowserIdentity;
	device?: WebsiteDevice;
	accountIdentifiers?: AccountIdentifierExtractor;
	/** Files the answer may attach, by name; rechecks add their screenshots here. */
	attachable: Map<string, AttachableFile>;
};

export type DecisionToolDependencies = {
	capture?: typeof archiveWebsite;
	fetch?: typeof fetch;
	/** The check that a requested host resolves only to public addresses. */
	assertPublicHost?: (hostname: string) => Promise<void>;
	/** The RFC 3161 authority that timestamps a recheck's evidence. */
	timestamp?: typeof timestampEvidence;
};

const MAX_TEXT = 15_000;
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/** The function tools the follow-up agent can call, as the Responses API declares them. */
export const DECISION_TOOL_DEFINITIONS = [
	{
		type: "function",
		name: "recheck_page",
		description: "Open a URL in a real browser now, the way the case captured it (Tor first, then our server's address, then a residential connection when the site cloaks), presenting the reporter's browser. Returns where it ended, over which route, how the routes were answered, the rendered page text (hidden dialogs included), any paste-and-run commands decoded layer by layer, identifiers of accounts at the provider found in the page, and the name of a stamped screenshot you may attach.",
		parameters: {
			type: "object",
			properties: {
				url: { type: "string" },
				device: { type: "string", enum: ["case", "iphone"], description: "`case`: the browser the case used; `iphone`: Safari on an iPhone, for kits that serve only phones." },
			},
			required: ["url", "device"],
			additionalProperties: false,
		},
		strict: true,
	},
	{
		type: "function",
		name: "fetch_url",
		description: "Request a URL once with a chosen User-Agent, without a browser (no scripts run), following redirects. Returns the status, the redirect chain, content type, size, SHA-256, and the start of the body when it is text. Use it for payload hosts that serve a file only to a command-line downloader, or to show what a plain request gets.",
		parameters: {
			type: "object",
			properties: { url: { type: "string" }, userAgent: { type: "string" } },
			required: ["url", "userAgent"],
			additionalProperties: false,
		},
		strict: true,
	},
	{
		type: "function",
		name: "read_case_capture",
		description: "Read the text of one page the case captured when it was reported (names are listed in caseCaptures).",
		parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
		strict: true,
	},
	{
		type: "function",
		name: "answer",
		description: "Send your answer to the provider. The text is sent exactly as you write it, through the channel described in the context. Attach files by name from attachableFiles or from screenshots your rechecks returned.",
		parameters: {
			type: "object",
			properties: {
				text: { type: "string", description: "The complete message, greeting and sign-off included." },
				attachments: { type: "array", items: { type: "string" } },
				summary: { type: "string", description: "One or two sentences for our case page: why you answered and what you asked for." },
			},
			required: ["text", "attachments", "summary"],
			additionalProperties: false,
		},
		strict: true,
	},
	{
		type: "function",
		name: "do_not_answer",
		description: "Send nothing. Use it when an answer would not help: the provider is right, the content is gone, or there is nothing new to tell them.",
		parameters: {
			type: "object",
			properties: { reason: { type: "string", description: "One or two sentences for our case page: why no answer was sent." } },
			required: ["reason"],
			additionalProperties: false,
		},
		strict: true,
	},
] as const;

/** The case's captured pages by name (`website.mhtml`, `website-step2.mhtml`, …). */
export async function caseCaptureNames(submissionId: bigint | undefined): Promise<string[]> {
	if (submissionId === undefined) return [];
	return (await ArtifactsEntity.listForSubmission(submissionId)).map((artifact) => artifact.name ?? "").filter((name) => /^website(?:-step\d+)?\.mhtml$/.test(name));
}

/** Run one tool call; a failure is a result the agent reads, not an exception. */
export async function runDecisionTool(name: string, args: Record<string, unknown>, context: DecisionToolContext, dependencies: DecisionToolDependencies = {}): Promise<unknown> {
	try {
		if (name === "recheck_page") return await recheckPage(String(args.url), args.device === "iphone" ? "iphone" : "case", context, dependencies);
		if (name === "fetch_url") return await fetchUrl(String(args.url), String(args.userAgent), dependencies);
		if (name === "read_case_capture") return await readCaseCapture(String(args.name), context);
		return { error: `There is no tool named ${name}.` };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

async function recheckPage(url: string, device: "case" | "iphone", context: DecisionToolContext, dependencies: DecisionToolDependencies) {
	const identity = device === "iphone"
		? { device: "iphone" as const }
		: { ...(context.device ? { device: context.device } : {}), ...(context.visitor ? { visitor: context.visitor } : {}) };
	let archive;
	try {
		archive = await (dependencies.capture ?? archiveWebsite)({ url, ...identity });
	} catch (error) {
		if (error instanceof WebsiteCaptureFailedError) return { reached: false, failure: error.message };
		throw error;
	}
	const html = archive.html.toString("utf8");
	// The serialized DOM holds what scripts filled in, hidden dialogs included.
	const fullText = parse(html).structuredText;
	let screenshot: string | undefined;
	if (archive.screenshotPng) {
		const stamped = await buildWebsiteEvidence({
			caseId: context.submissionId?.toString() ?? "follow-up",
			step: 0,
			submittedUrl: archive.requestedUrl,
			capturedUrl: archive.url,
			capturedAt: archive.archivedAt,
			...(archive.route ? { route: archive.route } : {}),
			navigationHops: archive.navigationHops,
			screenshotPng: archive.screenshotPng,
			mhtml: archive.mhtml,
		}, dependencies.timestamp ? { timestamp: dependencies.timestamp } : {});
		if (stamped.stampedScreenshotPng) {
			screenshot = `recheck-${context.attachable.size + 1}.png`;
			context.attachable.set(screenshot, { filename: screenshot, mimeType: "image/png", content: stamped.stampedScreenshotPng });
		}
	}
	return {
		reached: true,
		checkedAt: archive.archivedAt.toISOString(),
		finalUrl: archive.url,
		route: archive.route ?? null,
		cloaking: archive.cloaking?.detail ?? null,
		userAgent: archive.userAgent ?? null,
		navigation: archive.navigationHops.map(({ url: hopUrl, status, redirectTo }) => ({ url: hopUrl, status, redirectTo: redirectTo ?? null })),
		pageText: archive.text.toString("utf8").slice(0, MAX_TEXT),
		pasteCommands: extractPasteCommands(fullText).map((command) => ({ shown: command.shown, decoded: command.layers.slice(1).map((layer) => layer.text), payloadUrls: command.payloadUrls })),
		accountIdentifiers: context.accountIdentifiers ? context.accountIdentifiers(html) : [],
		screenshot: screenshot ?? null,
	};
}

async function fetchUrl(url: string, userAgent: string, dependencies: DecisionToolDependencies) {
	const { response, urls } = await fetchThroughPublicRedirects(url, {
		subject: "requested",
		headers: { "user-agent": userAgent, accept: "*/*" },
		maxRedirects: 5,
		timeoutMs: FETCH_TIMEOUT_MS,
		...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
		...(dependencies.assertPublicHost ? { assertPublicHost: dependencies.assertPublicHost } : {}),
	});
	const chunks: Buffer[] = [];
	let size = 0;
	let truncated = false;
	for await (const chunk of (response.body ?? []) as unknown as AsyncIterable<Uint8Array>) {
		size += chunk.byteLength;
		if (size > MAX_FETCH_BYTES) {
			truncated = true;
			break;
		}
		chunks.push(Buffer.from(chunk));
	}
	const body = Buffer.concat(chunks);
	const contentType = response.headers.get("content-type") ?? "";
	const textual = /^(?:text\/|application\/(?:json|javascript|xml|x-sh))/i.test(contentType) || (!contentType && !body.subarray(0, 512).includes(0));
	return {
		status: response.status,
		redirects: urls,
		contentType: contentType || null,
		bytes: body.byteLength,
		truncated,
		sha256: truncated ? null : createHash("sha256").update(body).digest("hex"),
		bodyStart: textual ? body.toString("utf8").slice(0, 8_000) : null,
	};
}

async function readCaseCapture(name: string, context: DecisionToolContext) {
	if (context.submissionId === undefined) return { error: "This report has no case captures." };
	const artifact = (await ArtifactsEntity.listForSubmission(context.submissionId)).find((item) => item.name === name);
	const blob = artifact ? (await ArtifactsEntity.get(artifact.id))?.blob : undefined;
	if (!artifact || !blob) return { error: `The case has no capture named ${name}.` };
	const captured = await archiveWebsite({ url: "https://capture.invalid/", mhtmlSnapshot: Buffer.from(blob), trustMhtmlDocumentLocation: true });
	return {
		name,
		url: captured.url,
		capturedAt: (artifact.archivedAt ?? artifact.createdAt).toISOString(),
		text: captured.text.toString("utf8").slice(0, MAX_TEXT),
	};
}
