import { createHash } from "node:crypto";
import { parse } from "node-html-parser";

import type { BrowserIdentity } from "../../browser/page";
import { ArtifactsEntity } from "../../db/entities";
import { buildWebsiteEvidence } from "../../evidence/package";
import type { timestampEvidence } from "../../evidence/timestamp";
import { extractPasteCommands } from "../../malware/paste_commands";
import { fetchThroughPublicRedirects } from "../../network/public_redirects";
import { AbuseSkyvernAdapter } from "../skyvern";
import { createExfiltrationCanaries } from "../../exfiltration/canaries";
import { skyvernVisitAgent, type VisitAgent } from "../../site_visit/agent";
import { visitPages } from "../../site_visit/evidence";
import { archiveWebsite, WebsiteCaptureFailedError, type WebsiteArchiveResult } from "../../website_archive";
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
	/** The agent that walks the site in `visit_site`; Skyvern in production. */
	visitAgent?: VisitAgent;
	/** The job's deadline; a visit stops when it fires. */
	signal?: AbortSignal;
};

const MAX_TEXT = 15_000;
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/** The function tools the follow-up agent can call, as the Responses API declares them. */
export const DECISION_TOOL_DEFINITIONS = [
	{
		type: "function",
		name: "recheck_page",
		description: "Open a URL in a real browser now, the way the case captured it (Tor first, then our server's address, then a residential connection when the site cloaks), presenting the reporter's browser. Returns where it ended, over which route, how the routes were answered, the text a visitor sees on load, the full document text after scripts ran (closed dialogs and hidden elements a button reveals included), any paste-and-run commands in the document decoded layer by layer, identifiers of accounts at the provider found in it, and the name of a stamped screenshot you may attach.",
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
		name: "visit_site",
		description: "Walk the site from a URL the way its victim would, with an AI browser agent in the same browser recheck_page uses: it clicks through, opens dialogs, fills forms with made-up values only (never real data), submits them, and starts downloads, without ever running anything. Returns every page it reached (each described like recheck_page, with its own screenshot), the requests that carried the made-up values and where they went, every downloaded file with its SHA-256, and the agent's own account of what it did. Takes several minutes; use it when what matters only shows after interaction. `instructions` tells the visiting agent what to do or look for on top of the walk, for example which button to press, which step to reach, or what to check.",
		parameters: {
			type: "object",
			properties: {
				url: { type: "string" },
				device: { type: "string", enum: ["case", "iphone"], description: "`case`: the browser the case used; `iphone`: Safari on an iPhone." },
				instructions: { type: "string", description: "Extra instructions for the visiting agent; empty for a plain walk." },
			},
			required: ["url", "device", "instructions"],
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
		if (name === "visit_site") return await visitSite(String(args.url), args.device === "iphone" ? "iphone" : "case", String(args.instructions ?? ""), context, dependencies);
		if (name === "fetch_url") return await fetchUrl(String(args.url), String(args.userAgent), dependencies);
		if (name === "read_case_capture") return await readCaseCapture(String(args.name), context);
		return { error: `There is no tool named ${name}.` };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

async function recheckPage(url: string, device: "case" | "iphone", context: DecisionToolContext, dependencies: DecisionToolDependencies) {
	let archive;
	try {
		archive = await (dependencies.capture ?? archiveWebsite)({ url, ...captureIdentity(device, context) });
	} catch (error) {
		if (error instanceof WebsiteCaptureFailedError) return { reached: false, failure: error.message };
		throw error;
	}
	return { reached: true, ...await describePage(archive, "recheck", context, dependencies) };
}

/**
 * Walk the site with the visiting agent from a live capture held open, as
 * the case's own visit did, and describe every page it reached with what each
 * sent off and made the visitor download.
 */
async function visitSite(url: string, device: "case" | "iphone", instructions: string, context: DecisionToolContext, dependencies: DecisionToolDependencies) {
	let first;
	try {
		first = await (dependencies.capture ?? archiveWebsite)({ url, ...captureIdentity(device, context), keepSession: true });
	} catch (error) {
		if (error instanceof WebsiteCaptureFailedError) return { reached: false, failure: error.message };
		throw error;
	}
	const { session } = first;
	if (!session) return { reached: true, error: "The page could not be held open for a visit." };
	try {
		const canaries = createExfiltrationCanaries();
		const recording = await session.visit({
			canaries,
			agent: dependencies.visitAgent ?? skyvernVisitAgent(() => new AbuseSkyvernAdapter()),
			...(instructions.trim() ? { instructions } : {}),
			...(dependencies.signal ? { signal: dependencies.signal } : {}),
		});
		const pages = [];
		for (const page of visitPages(first, recording, canaries)) {
			pages.push({
				...await describePage(page.archive, "visit", context, dependencies),
				sentMadeUpData: page.dataSent.map(({ url: sentTo, method, fields, sameSite }) => ({ url: sentTo, method, fields, sameSite })),
				downloads: page.downloads.map((file) => ({ url: file.url, fileName: file.fileName, contentType: file.contentType ?? null, bytes: file.bytes.byteLength, sha256: createHash("sha256").update(file.bytes).digest("hex") })),
			});
		}
		return {
			reached: true,
			agent: {
				outcome: recording.agent.outcome,
				report: recording.agent.report ?? null,
				failure: recording.agent.failure ?? null,
				actions: recording.agent.actions.map((action) => action.text),
			},
			madeUpValues: { email: canaries.email, password: canaries.password, phone: canaries.phone, cardNumber: canaries.cardNumber },
			pages,
			downloadFailures: recording.downloadFailures,
		};
	} finally {
		await session.close();
	}
}

function captureIdentity(device: "case" | "iphone", context: DecisionToolContext) {
	return device === "iphone"
		? { device: "iphone" as const }
		: { ...(context.device ? { device: context.device } : {}), ...(context.visitor ? { visitor: context.visitor } : {}) };
}

/** One captured page as the agent reads it, its stamped screenshot made attachable. */
async function describePage(archive: WebsiteArchiveResult, kind: "recheck" | "visit", context: DecisionToolContext, dependencies: DecisionToolDependencies) {
	// The live DOM: what scripts filled in, and the closed dialog a button opens.
	// The archive's own HTML and text keep only what a visitor sees before clicking.
	const documentHtml = archive.documentHtml ?? archive.html.toString("utf8");
	const document = parse(documentHtml);
	document.querySelectorAll("script, style, noscript, svg").forEach((element) => element.remove());
	const documentText = document.structuredText.replaceAll(/ *\n[\n ]*/g, "\n").trim();
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
			screenshot = `${kind}-${context.attachable.size + 1}.png`;
			context.attachable.set(screenshot, { filename: screenshot, mimeType: "image/png", content: stamped.stampedScreenshotPng });
		}
	}
	return {
		checkedAt: archive.archivedAt.toISOString(),
		finalUrl: archive.url,
		route: archive.route ?? null,
		cloaking: archive.cloaking?.detail ?? null,
		userAgent: archive.userAgent ?? null,
		navigation: archive.navigationHops.map(({ url: hopUrl, status, redirectTo }) => ({ url: hopUrl, status, redirectTo: redirectTo ?? null })),
		visiblePageText: archive.text.toString("utf8").slice(0, MAX_TEXT),
		fullDocumentText: documentText.slice(0, MAX_TEXT),
		pasteCommands: extractPasteCommands(documentText).map((command) => ({ shown: command.shown, decoded: command.layers.slice(1).map((layer) => layer.text), payloadUrls: command.payloadUrls })),
		accountIdentifiers: context.accountIdentifiers ? context.accountIdentifiers(documentHtml) : [],
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
