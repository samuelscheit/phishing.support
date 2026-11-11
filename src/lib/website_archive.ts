import { createHash } from "node:crypto";

import { type Frame, type HTTPRequest, type HTTPResponse, type Page, TimeoutError } from "rebrowser-puppeteer-core";
import sharp from "sharp";
import { getDomain } from "tldts";

import { getBrowser, getBrowserPage } from "./browser";
import { FABRIC_EGRESS_LABEL, type FabricEgress } from "./browser/fabric";
import { sleep } from "./utils";
import type { WebsiteCloaking, WebsiteDevice, WebsiteHiddenFrame, WebsiteKitResource, WebsiteNavigationHop, WebsitePageAction, WebsitePerformedAction } from "./website_types";
import { hiddenFrames, recordFrameTraffic } from "./website_hidden_frames";
import { CAPTCHA_PROVIDER_FRAME, performPageAction, WebsitePageActionTargetMissingError } from "./website_page_actions";
import { isSameWebsite, websiteSite } from "./website_site";
// @ts-ignore
import { convert } from "mhtml-to-html";
import parse, { HTMLElement } from "node-html-parser";
import { errorText } from "./error_text";

export type ArchivedWebsiteResponse = {
	name: string;
	meta: {
		url: string;
		status: number;
		headers: Record<string, string>;
		method: string;
		remoteAddress: unknown;
		accessedAt: string;
	};
	body: Buffer;
};

export type WebsiteArchiveResult = {
	/** The submitted URL is retained separately from the captured document URL. */
	requestedUrl: string;
	/** How the capture handled the page's scripted jump to another site. */
	cloaking?: WebsiteCloaking;
	/** Set when the captured page sat behind a fake verification gate that was clicked through. */
	verificationGate?: WebsiteVerificationGate;
	/**
	 * The last page action the capture took to reach the captured page.
	 * `navigationHops` then starts at the response to that action.
	 */
	performedAction?: WebsitePerformedAction;
	/** URL whose document body, screenshot, and MHTML are captured. */
	url: string;
	hostname: string;
	navigationHops: WebsiteNavigationHop[];
	/** Timestamp embedded in the MHTML capture, or the capture time when it is not available. */
	archivedAt: Date;
	/** The network route the live capture used, for example "Tor exit"; absent for MHTML. */
	route?: string;
	screenshotPng?: Buffer;
	mhtml: Buffer;
	html: Buffer;
	text: Buffer;
	/** Scripts and stylesheets the live capture received, from any host; MHTML drops scripts and re-serializes CSS. */
	kitResources?: WebsiteKitResource[];
	/** Frames of the captured page no visitor can see, with the code they loaded; MHTML keeps none of it. */
	hiddenFrames?: WebsiteHiddenFrame[];
	/** The browser the live capture presented; absent means the Windows desktop. */
	device?: WebsiteDevice;
	/** Non-empty when an uploaded snapshot claims a different host than the submitted target. */
	attributionError?: string;
	/** The open browser of a live capture made with `keepSession`. */
	session?: WebsitePageSession;
};

/**
 * A live capture's browser, kept open on the captured page: the flow acts on
 * that page as a visitor would (same cookies, same session, same variant of
 * a kit that changes per visit) and captures what it then shows.
 */
export type WebsitePageSession = {
	/** Take one step on the page as it stands and capture what it then shows; its hops start at the step's response. */
	act(action: WebsitePageAction): Promise<WebsiteArchiveResult>;
	/** Release the browser; later calls do nothing. */
	close(): Promise<void>;
};

const WEBSITE_NAVIGATION_TIMEOUT_MS = 30_000;
const KIT_RESOURCE_TYPES = new Set(["script", "stylesheet"]);
const MAX_KIT_RESOURCES = 40;
const MAX_KIT_RESOURCE_BYTES = 2 * 1024 * 1024;

/**
 * Record the hash of every script and stylesheet response body, from any
 * host, exactly as received. These are the bytes urlscan.io hashes; the MHTML
 * snapshot cannot provide them because it omits scripts and rewrites CSS.
 * A loader kit serves its real code from a separate backend host, so those
 * files are kept too; sibling discovery judges each one by its rarity.
 */
function recordKitResources(page: Page): { settled: () => Promise<WebsiteKitResource[]> } {
	const pending: Array<Promise<WebsiteKitResource | undefined>> = [];
	page.on("response", (response) => {
		const request = response.request();
		if (pending.length >= MAX_KIT_RESOURCES || !KIT_RESOURCE_TYPES.has(request.resourceType()) || response.status() !== 200) return;
		pending.push((async () => {
			const body = await response.buffer();
			if (body.byteLength === 0 || body.byteLength > MAX_KIT_RESOURCE_BYTES) return undefined;
			return {
				url: response.url(),
				mimeType: (response.headers()["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase() || request.resourceType(),
				size: body.byteLength,
				sha256: createHash("sha256").update(body).digest("hex"),
			};
		})().catch(() => undefined));
	});
	return {
		// Once per hash: the same file under a second URL identifies nothing new.
		settled: async () => (await Promise.all(pending)).filter((resource, index, all): resource is WebsiteKitResource =>
			Boolean(resource) && all.findIndex((other) => other?.sha256 === resource!.sha256) === index),
	};
}

export type ArchiveWebsiteOptions = {
	/** Raw MHTML (decoded bytes). It is parsed locally; Fabric browsers never receive an app-local file:// URL. */
	mhtmlSnapshot?: Buffer;
	/** Original user-submitted URL. */
	url: string;
	/** The page whose link a live capture follows; the browser sends it as the Referer, as a visitor's would. */
	referrer?: string;
	/** Original location represented by the retained MHTML document, when known. */
	archivedUrl?: string;
	/** Exact response hops associated with the retained MHTML document, when known. */
	navigationHops?: WebsiteNavigationHop[];
	/** Only true for MHTML read back from this service's own stored artifact. */
	trustMhtmlDocumentLocation?: boolean;
	/** The verification gate the retained MHTML was captured behind, when known. */
	verificationGate?: WebsiteVerificationGate;
	/** Kit resources the original live capture of the retained MHTML received. */
	kitResources?: WebsiteKitResource[];
	/** Hidden frames the original live capture of the retained MHTML recorded. */
	hiddenFrames?: WebsiteHiddenFrame[];
	/** The browser a live capture presents, and the retained MHTML was captured with. */
	device?: WebsiteDevice;
	/**
	 * Keep the live capture's browser open as the result's `session`, so the
	 * caller can act on the captured page in the same visit; the caller closes it.
	 */
	keepSession?: boolean;
};

/** Read a top-level MHTML header; MIME-part headers must never override capture metadata. */
function getMhtmlHeader(snapshot: Buffer, name: string): string | undefined {
	const crlfHeaderEnd = snapshot.indexOf("\r\n\r\n");
	const lfHeaderEnd = snapshot.indexOf("\n\n");
	const headerEnd = crlfHeaderEnd >= 0 ? crlfHeaderEnd : lfHeaderEnd;
	const preamble = snapshot
		.subarray(0, headerEnd < 0 ? snapshot.byteLength : headerEnd)
		.toString("latin1")
		.replace(/\r?\n[\t ]+/g, " ");
	return preamble.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))?.[1]?.trim();
}

/** Reads the capture time emitted by Chromium's MHTML snapshot writer. */
export function getMhtmlArchiveDate(snapshot: Buffer): Date | undefined {
	const value = getMhtmlHeader(snapshot, "Date");
	if (!value) return undefined;
	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
}

/** Reads Chromium's document URL so old retained snapshots remain correctly attributed. */
export function getMhtmlArchiveLocation(snapshot: Buffer): string | undefined {
	const value = getMhtmlHeader(snapshot, "Snapshot-Content-Location");
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

async function archiveMhtmlSnapshot(options: ArchiveWebsiteOptions & { mhtmlSnapshot: Buffer }): Promise<WebsiteArchiveResult> {
	const declaredDocumentUrl = getMhtmlArchiveLocation(options.mhtmlSnapshot);
	const requestedUrl = new URL(options.url);
	const attributionError = !options.archivedUrl && !options.trustMhtmlDocumentLocation && declaredDocumentUrl && !isSameWebsite(declaredDocumentUrl, requestedUrl)
		? `The uploaded MHTML declares ${websiteSite(declaredDocumentUrl)}, but the submitted target is ${websiteSite(requestedUrl)}.`
		: undefined;
	const documentUrl = attributionError
		? options.url
		: options.archivedUrl ?? (options.trustMhtmlDocumentLocation ? declaredDocumentUrl : undefined) ?? options.url;
	const { hostname } = new URL(documentUrl);
	const navigationHops = options.navigationHops?.length
		? options.navigationHops
		: attributionError
			? [{ index: 0, url: options.url, hostname: requestedUrl.hostname, status: null, contentCaptured: false }]
			: documentUrl === options.url
				? [{ index: 0, url: documentUrl, hostname, status: null, contentCaptured: true }]
				: [
						{ index: 0, url: options.url, hostname: requestedUrl.hostname, status: null, redirectTo: documentUrl, contentCaptured: false },
						{ index: 1, url: documentUrl, hostname, status: null, contentCaptured: true },
					];
	const { data } = await convert(options.mhtmlSnapshot, {
		enableScripts: false,
		fetchMissingResources: false,
	});
	const { html, text } = capturedDocumentContent(data);
	return {
		requestedUrl: options.url,
		url: documentUrl,
		hostname,
		navigationHops,
		archivedAt: getMhtmlArchiveDate(options.mhtmlSnapshot) ?? new Date(),
		mhtml: options.mhtmlSnapshot,
		html: Buffer.from(html, "utf-8"),
		text: Buffer.from(text, "utf-8"),
		...(attributionError ? { attributionError } : {}),
		...(options.verificationGate ? { verificationGate: options.verificationGate } : {}),
		...(options.kitResources?.length ? { kitResources: options.kitResources } : {}),
		...(options.hiddenFrames?.length ? { hiddenFrames: options.hiddenFrames } : {}),
		...(options.device && options.device !== "desktop" ? { device: options.device } : {}),
	};
}

const TEXT_ATTRIBUTES = ["placeholder", "aria-placeholder", "aria-label"] as const;
const CAPTION_INPUT_TYPES = new Set(["button", "reset", "submit"]);

/**
 * Text a visitor reads from attributes rather than text nodes: field hints,
 * button captions, image alternatives, and accessible labels. Kits often label
 * their fields only with placeholders and their buttons with input values.
 * Each caption becomes its own line where its element stands, so the text
 * keeps the order a visitor reads and a quote spanning a heading and the
 * fields below it appears in the text as it does on the page.
 */
function inlineAttributeText(dom: HTMLElement): void {
	for (const element of dom.querySelectorAll("[placeholder], [aria-placeholder], [aria-label], img[alt], input[value]")) {
		const tag = element.tagName.toLowerCase();
		const ownText = compactText(element.textContent);
		const captions = new Set([
			...TEXT_ATTRIBUTES.map((attribute) => element.getAttribute(attribute)),
			tag === "img" ? element.getAttribute("alt") : undefined,
			tag === "input" && CAPTION_INPUT_TYPES.has(element.getAttribute("type")?.trim().toLowerCase() ?? "") ? element.getAttribute("value") : undefined,
		].map(compactText).filter((caption) => caption && caption !== ownText));
		for (const caption of captions) {
			const line = new HTMLElement("div", {}, "");
			line.textContent = caption;
			element.before(line);
		}
	}
}

function compactText(value: string | undefined): string {
	return value?.replace(/\s+/g, " ").trim() ?? "";
}

/**
 * Inline styles that keep an element's text from any visitor. Kits pad pages
 * with large blocks of such text (zero font size, zero opacity) so that a
 * scanner reading the document sees harmless filler instead of the login form.
 * Fractional values such as `opacity: 0.5` remain visible.
 */
const HIDING_INLINE_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?:\.0+)?|font-size\s*:\s*0(?:px|pt|em|rem|%)?)\s*(?:!\s*important\s*)?(?=;|$)/i;

/** Frames nest this deep on real pages: Google Sites → Apps Script sandbox → the script's own page. */
const MAX_INLINED_FRAME_DEPTH = 5;

function parseDocument(html: string): HTMLElement {
	// The doctype parses as a text node and would otherwise lead the page text.
	return parse(html.replace(/^\s*<!DOCTYPE[^>]*>/i, ""), { comment: false });
}

/**
 * Replace each frame with the document it showed. Chromium's MHTML keeps a
 * frame's document in the frame's `srcdoc` once converted, where neither the
 * page text nor the field extraction would see it; a visitor sees it in place.
 * The frame's own hiding attributes move to its content.
 */
function inlineFrames(dom: HTMLElement, depth = 0): void {
	for (const frame of dom.querySelectorAll("iframe, frame")) {
		const srcdoc = frame.getAttribute("srcdoc");
		const content = new HTMLElement("div", {}, "");
		for (const attribute of ["hidden", "style"]) {
			const value = frame.getAttribute(attribute);
			if (value !== undefined) content.setAttribute(attribute, value);
		}
		if (srcdoc && depth < MAX_INLINED_FRAME_DEPTH) {
			const document = parseDocument(srcdoc);
			inlineFrames(document, depth + 1);
			content.set_content((document.querySelector("body") ?? document).innerHTML);
		}
		frame.replaceWith(content);
	}
}

/** Sanitized HTML and visitor-readable text of a captured document, with its frames shown in place. */
export function capturedDocumentContent(documentHtml: string): { html: string; text: string } {
	const dom = parseDocument(documentHtml);
	const title = dom.querySelector("title")?.textContent ?? "";
	const description = dom.querySelector("meta[name='description'], meta[property='og:description'], meta[property='twitter:description']")?.getAttribute("content") ?? "";
	inlineFrames(dom);
	dom.querySelectorAll("script, style, link, svg, noscript").forEach((element) => element.remove());
	dom.querySelectorAll("[hidden], [style]")
		.filter((element) => element.hasAttribute("hidden") || HIDING_INLINE_STYLE.test(element.getAttribute("style") ?? ""))
		.forEach((element) => element.remove());
	dom.querySelectorAll("*").forEach((element) => element.removeAttribute("style"));
	const textDom = parse(dom.outerHTML);
	inlineAttributeText(textDom);
	dom.querySelectorAll("img").forEach((element) => element.remove());
	const text = [title, description, textDom.structuredText].filter(Boolean).join("\n\n")
		.replaceAll(/ +/g, " ")
		.replaceAll(/ *\n[\n ]*/g, "\n")
		.trim();
	return { html: dom.outerHTML, text };
}

export type WebsiteArchiveDependencies = {
	getBrowser?: typeof getBrowser;
	/** Test seam for the bounded wait on a self-replacing HTTP error document. */
	errorDocumentSettleMs?: number;
	/** Test seam for the bounded wait on a page's own script navigation. */
	scriptNavigationSettleMs?: number;
	/** Test seam for the bounded wait on the captured document's own rendering requests. */
	renderSettleMs?: number;
	/** Test seam for the bounded wait on what a page action opens. */
	pageActionSettleMs?: number;
	/** Test seam for how long a page's changed text must stay the same to count as the action's result. */
	pageActionQuietMs?: number;
	/** Test seam for the bounded wait on a captcha widget beside a submitted field. */
	humanCheckMs?: number;
	/** Test seam for which frames are a captcha provider's widget. */
	captchaProviderFrame?: RegExp;
};

/**
 * What a fake human-verification gate revealed: the kit's own "I'm not a robot"
 * control, drawn by the kit (in the page or a frame of its own) rather than by
 * a captcha provider, which only swaps in the real page once clicked.
 */
export type WebsiteVerificationGate = {
	/** The control's own caption, e.g. "I'm not a robot". */
	label: string;
};

export function navigationHopsFromResponse(
	response: HTTPResponse | null,
	finalUrl: string,
): WebsiteNavigationHop[] {
	const finalRequest = response?.request();
	const requests = finalRequest ? [...finalRequest.redirectChain(), finalRequest] : [];
	if (requests.length === 0) {
		const { hostname } = new URL(finalUrl);
		return [{ index: 0, url: finalUrl, hostname, status: response?.status() ?? null, contentCaptured: true }];
	}

	const hops = requests.map((request: HTTPRequest, index) => {
		const responseForHop = request === finalRequest ? response : request.response();
		const hopUrl = request.url();
		const { hostname } = new URL(hopUrl);
		const status = responseForHop?.status() ?? null;
		const headers = responseForHop?.headers() ?? {};
		const location = status !== null && status >= 300 && status < 400 ? headers.location : undefined;
		let redirectTo: string | undefined;
		if (location) {
			try {
				redirectTo = new URL(location, hopUrl).toString();
			} catch {
				// Keep malformed redirect destinations out of the navigation record.
			}
		}

		return {
			index,
			url: hopUrl,
			hostname,
			status,
			...(redirectTo ? { redirectTo } : {}),
			...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
			contentCaptured: false,
		};
	});

	const matchingCapturedIndex = hops.findLastIndex((hop) => hop.url === finalUrl);
	if (matchingCapturedIndex >= 0) hops[matchingCapturedIndex]!.contentCaptured = true;
	else {
		const { hostname } = new URL(finalUrl);
		const previousHop = hops.at(-1);
		if (previousHop && !previousHop.redirectTo) previousHop.redirectTo = finalUrl;
		hops.push({ index: hops.length, url: finalUrl, hostname, status: null, contentCaptured: true });
	}
	return hops;
}

/**
 * Egress routes tried for a live capture, in order. Tor keeps the reporting
 * server's address away from attacker infrastructure, but Tor exits are widely
 * blocked, either with an HTTP error page or by dropping the connection; a page
 * that is unreachable over Tor is retried from the server's own direct exit.
 * Cloakers go further and answer Tor and datacenter visitors with a script
 * navigation to an unrelated decoy site; only then is the capture repeated from
 * the operator's residential exit, which exposes that connection's address.
 */
const WEBSITE_CAPTURE_EGRESS: readonly FabricEgress[] = ["phishing", "reporting"];
const WEBSITE_CLOAKING_EGRESS: FabricEgress = "residential";

/** How long an HTTP error document may take to replace itself, e.g. a JavaScript bot-check interstitial. */
const WEBSITE_ERROR_DOCUMENT_SETTLE_MS = 20_000;
const WEBSITE_ERROR_DOCUMENT_POLL_MS = 500;
/** How long a loaded page may take before its own script navigates the main frame elsewhere. */
const WEBSITE_SCRIPT_NAVIGATION_SETTLE_MS = 8_000;
/** How long the captured document may keep fetching what it renders before it is captured as it stands. */
const WEBSITE_RENDER_SETTLE_MS = 10_000;
/** How long a page action's next step may take to show. */
const WEBSITE_PAGE_ACTION_SETTLE_MS = 25_000;
/** How long a page's changed text must stay the same before it counts as the action's result rather than its progress indicator. */
const WEBSITE_PAGE_ACTION_QUIET_MS = 5_000;
/** How often a clicked verification gate is checked for the page it reveals. */
const WEBSITE_GATE_POLL_MS = 250;
/** A quiet network for this long means the page's script has fetched what it renders. */
const WEBSITE_RENDER_IDLE_MS = 1_000;
/** Requests that may stay open while the page counts as rendered: analytics beacons, long polls, captcha widgets. */
const WEBSITE_RENDER_IDLE_CONCURRENCY = 2;

/**
 * The site's main document could not be loaded over one egress route: the
 * navigation failed, or it answered with an HTTP error that did not resolve itself.
 */
/**
 * The browser service failed rather than the site: Fabric's relay was full or
 * unreachable, the CDP connection dropped, or the leased browser closed under
 * the capture. These say nothing about the site and are worth retrying later.
 */
export class BrowserInfrastructureError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "BrowserInfrastructureError";
	}
}

const BROWSER_INFRASTRUCTURE_FAILURE = /Expected 101 status code|Unexpected server response: (?:502|503|504)|ECONNREFUSED|ECONNRESET|socket hang up|Target closed|Session closed|Connection closed|Protocol error|browser has disconnected|Navigating frame was detached|Execution context was destroyed|Browser Fabric (?:transport request failed|session ended)/i;

/** Every route failed to reach the site; its reasons may quote a route's own browser trouble. */
export class WebsiteCaptureFailedError extends Error {
	constructor(readonly failures: readonly WebsiteUnreachableError[]) {
		super(`Failed to load page: ${failures.map((error) => error.message).join("; ")}`);
		this.name = "WebsiteCaptureFailedError";
	}
}

/** Whether a capture failure came from the browser service rather than the site. */
export function isBrowserInfrastructureFailure(error: unknown): boolean {
	if (error instanceof WebsiteUnreachableError || error instanceof WebsiteCaptureFailedError) return false;
	return error instanceof BrowserInfrastructureError || BROWSER_INFRASTRUCTURE_FAILURE.test(errorText(error));
}

export class WebsiteUnreachableError extends Error {
	constructor(readonly egress: FabricEgress, readonly reason: string) {
		super(`${reason} via ${FABRIC_EGRESS_LABEL[egress]}`);
		this.name = "WebsiteUnreachableError";
	}
}

/** Registrable domain (eTLD+1) of a URL, falling back to its hostname. */
function siteOf(url: string): string {
	const { hostname } = new URL(url);
	return getDomain(hostname) ?? hostname;
}

/**
 * The site a capture's submitted page sent the visitor to by script, or
 * undefined when the capture stayed on the submitted site or followed an HTTP
 * redirect (the submitted host's declared destination).
 */
function scriptDestinationSite(archive: WebsiteArchiveResult): string | undefined {
	// The page that ran the script is the one that answered with a document
	// instead of an HTTP redirect. Short links reach a cloaker through HTTP
	// redirects of their own, which say nothing about where its script sends
	// this visitor.
	const scripted = archive.navigationHops.find((hop) => hop.redirectTo && !isHttpRedirect(hop.status) && siteOf(hop.redirectTo) !== siteOf(hop.url));
	return scripted ? siteOf(archive.url) : undefined;
}

function isHttpRedirect(status: number | null): boolean {
	return status !== null && status >= 300 && status < 400;
}

/**
 * Bot-check interstitials answer with 403/503 and then reload or redirect to
 * the real page once their script passes. Follow the main frame until it holds
 * a successful, parsed document, or give up after a bounded wait.
 */
async function settleErrorDocument(page: Page, latestDocumentResponse: () => HTTPResponse | null, settleMs: number): Promise<HTTPResponse | null> {
	const deadline = Date.now() + settleMs;
	while (Date.now() < deadline) {
		await sleep(WEBSITE_ERROR_DOCUMENT_POLL_MS);
		const response = latestDocumentResponse();
		if (!response?.ok()) continue;
		const readyState = await page.evaluate(() => document.readyState).catch(() => "loading");
		if (readyState !== "loading" && page.url() === response.url()) return response;
	}
	return null;
}

/**
 * Follow a main-frame navigation the loaded page starts by itself (for example
 * `location.href = ...` after a server-side visitor check). Returns the new
 * document's response once it is parsed, or undefined when the page stays put.
 */
async function settleScriptNavigation(
	page: Page,
	latestDocumentResponse: () => HTTPResponse | null,
	loadedResponse: HTTPResponse | null,
	settleMs: number,
): Promise<HTTPResponse | undefined> {
	const deadline = Date.now() + settleMs;
	while (Date.now() < deadline) {
		await sleep(WEBSITE_ERROR_DOCUMENT_POLL_MS);
		const response = latestDocumentResponse();
		if (!response || response === loadedResponse || !response.ok()) continue;
		const readyState = await page.evaluate(() => document.readyState).catch(() => "loading");
		if (readyState !== "loading" && page.url() === response.url()) return response;
	}
	return undefined;
}

/**
 * Site builders and single-page apps serve a shell and build the visible page
 * (a login form, for example) from XHR responses after DOMContentLoaded. Wait
 * until those requests are done so the capture holds what a visitor sees, but
 * never let a request that stays open hold the analysis: past the bound, the
 * document is captured as it stands.
 */
async function settleRendering(page: Page, settleMs: number): Promise<void> {
	await page.waitForNetworkIdle({ idleTime: Math.min(WEBSITE_RENDER_IDLE_MS, settleMs), concurrency: WEBSITE_RENDER_IDLE_CONCURRENCY, timeout: settleMs }).catch((error: unknown) => {
		if (!(error instanceof TimeoutError)) throw error;
	});
}

/**
 * Looks for a kit's own human-verification gate in one frame's document: a
 * single clickable "I'm not a robot"/"verify you are human" control, with no
 * data-entry field beside it. Real captcha widgets live in their provider's
 * frame, which is never scanned. A lone control is marked so it can be clicked.
 */
const GATE_ATTRIBUTE = "data-phishing-support-gate";
/**
 * Controls a visitor types into. The input types website_fields.ts does not
 * count as data entry are left out: a site's search box (Google Sites shows
 * one on every page) is not a kit's form.
 */
const DATA_ENTRY_SELECTOR = "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=search]):not([type=range]):not([type=color]), textarea, select";
type FrameGateScan = { fields: boolean; controls: number; label: string | null };
function scanVerificationGate(dataEntrySelector: string): FrameGateScan {
	const caption = /\b(?:i['’`]?\s*a?m\s+not\s+a\s+robot|verify\s+(?:that\s+)?you\s+are\s+(?:a\s+)?human|(?:confirm|prove)\s+(?:that\s+)?you(?:['’`]re|\s+are)\s+(?:a\s+)?human)\b/i;
	const visible = (element: Element) => {
		const box = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		return box.width > 4 && box.height > 4 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.1;
	};
	if ([...document.querySelectorAll(dataEntrySelector)].some(visible)) return { fields: true, controls: 0, label: null };
	// A kit often draws its checkbox as a bare <div> whose script listens for the
	// click (x-com.email's fake Turnstile); the hand cursor it styles is the only
	// mark it carries. The cursor is inherited, so the element that sets it is the
	// one the listener sits on. Links lead elsewhere and are no gate.
	const setsPointer = (element: Element) => !element.matches("a[href], area[href]")
		&& getComputedStyle(element).cursor === "pointer"
		&& (!element.parentElement || getComputedStyle(element.parentElement).cursor !== "pointer");
	const clickable = [...new Set([
		...document.querySelectorAll("[role=button], [role=checkbox], button, input[type=checkbox], label, [tabindex]"),
		...[...document.querySelectorAll("body *")].filter(setsPointer),
	])].filter(visible);
	// A control's caption is its own text or, for an empty checkbox drawn next
	// to its caption, the text of the nearest widget around it that holds no
	// other control.
	const captionOf = (control: Element): string | null => {
		let node: Element | null = control;
		for (let depth = 0; node && depth <= 3; node = node.parentElement, depth++) {
			if (depth > 0 && clickable.some((other) => other !== control && node!.contains(other) && !control.contains(other) && !other.contains(control))) return null;
			const found = caption.exec(`${node.getAttribute("aria-label") ?? ""} ${node.textContent ?? ""}`);
			if (found) return found[0];
		}
		return null;
	};
	const candidates = clickable.flatMap((element) => {
		const text = captionOf(element);
		return text === null ? [] : [{ element, text }];
	});
	// The innermost control carrying the caption is the one a visitor clicks.
	const controls = candidates.filter(({ element }) => !candidates.some((other) => other.element !== element && element.contains(other.element)));
	if (controls.length !== 1) return { fields: false, controls: controls.length, label: null };
	const [{ element: control, text }] = controls as [{ element: Element; text: string }];
	// Same value as GATE_ATTRIBUTE; this function runs in the page, not here.
	control.setAttribute("data-phishing-support-gate", "");
	const label = text.replace(/\s+/g, " ").trim();
	return { fields: false, controls: 1, label: label.slice(0, 120) || "verification gate" };
}


/** Whether a frame is drawn on the page: every frame element up to the top document has a visible box. */
async function frameIsVisible(frame: Frame): Promise<boolean> {
	for (let current = frame; current.parentFrame(); current = current.parentFrame()!) {
		const element = await current.frameElement().catch(() => null);
		const box = await element?.boundingBox().catch(() => null);
		await element?.dispose().catch(() => undefined);
		if (!box || box.width <= 4 || box.height <= 4) return false;
	}
	return true;
}

/**
 * Clicks through a kit's fake verification gate, like a visitor would, and
 * waits for the page it reveals. The gate may sit in any visible frame: Google
 * Sites shows an embedded Apps Script page two sandbox frames deep. Across all
 * of them there must be exactly one gate control and no data-entry field.
 * Returns the gate when one was clicked.
 */
async function passVerificationGate(page: Page, settleMs: number): Promise<WebsiteVerificationGate | undefined> {
	const scans: Array<{ frame: Frame; scan: FrameGateScan }> = [];
	for (const frame of page.frames()) {
		if (frame.detached || CAPTCHA_PROVIDER_FRAME.test(frame.url()) || !await frameIsVisible(frame)) continue;
		const scan = await frame.evaluate(scanVerificationGate, DATA_ENTRY_SELECTOR).catch(() => null);
		if (scan) scans.push({ frame, scan });
	}
	const gate = scans.find(({ scan }) => scan.label);
	try {
		if (!gate || scans.some(({ scan }) => scan.fields) || scans.reduce((total, { scan }) => total + scan.controls, 0) !== 1) return undefined;
		const control = await gate.frame.$(`[${GATE_ATTRIBUTE}]`);
		if (!control) return undefined;
		try {
			await control.click({ delay: 60 + Math.round(Math.random() * 80) });
			// Gates verify against their own backend first (a proof of work, a
			// warm-up call), then swap in or navigate their frame to the real page.
			// Neither the gate leaving nor a quiet network says that page is there:
			// the proof of work is silent and runs on behind a "Verifying" spinner.
			await waitForRevealedForm(page, settleMs);
			await settleRendering(page, settleMs);
		} finally {
			await control.dispose().catch(() => undefined);
		}
		return { label: gate.scan.label! };
	} finally {
		for (const { frame } of scans) {
			await frame.evaluate((attribute: string) => document.querySelector(`[${attribute}]`)?.removeAttribute(attribute), GATE_ATTRIBUTE).catch(() => undefined);
		}
	}
}

/** Whether a frame's document shows a field a visitor can type into. */
function showsDataEntryField(dataEntrySelector: string): boolean {
	return [...document.querySelectorAll(dataEntrySelector)].some((element) => {
		const box = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		return box.width > 4 && box.height > 4 && style.visibility !== "hidden" && style.display !== "none";
	});
}

/**
 * Waits until a frame on the page shows the form the gate revealed, through
 * any navigation of the gate's frame, then for that form's own requests. Past
 * the bound the page is captured as it stands.
 */
async function waitForRevealedForm(page: Page, settleMs: number): Promise<void> {
	const deadline = Date.now() + settleMs;
	while (Date.now() < deadline) {
		await sleep(WEBSITE_GATE_POLL_MS);
		let revealed = false;
		for (const frame of page.frames()) {
			// A frame mid-navigation has no document to ask yet.
			if (!frame.detached && await frame.evaluate(showsDataEntryField, DATA_ENTRY_SELECTOR).catch(() => false) && await frameIsVisible(frame)) revealed = true;
		}
		if (revealed) break;
	}
	await settleRendering(page, Math.max(WEBSITE_RENDER_IDLE_MS, deadline - Date.now()));
}

/** A response a site sent over the network, not one Chromium made itself (chrome-error://, blob:). */
function isNetworkDocument(response: HTTPResponse): boolean {
	return /^https?:/i.test(response.url());
}

/**
 * The http(s) address a captured main-frame document belongs to. Kits that
 * fetch their real page and swap it in through `location.replace(blob:...)`
 * leave a blob: document of their own origin in the main frame; it is still the
 * page the visitor loaded. Anything else that is not http(s), such as
 * Chromium's own chrome-error:// page, belongs to no site.
 */
function documentAddress(pageUrl: string, loadedUrl: string): string | undefined {
	const page = new URL(pageUrl);
	if (/^https?:$/i.test(page.protocol)) return page.toString();
	if (page.protocol === "blob:" && page.origin === new URL(loadedUrl).origin) return loadedUrl;
	return undefined;
}

/**
 * Hops of every main-frame document the visit passed through, in order. Each
 * document but the last sent the visitor on by script, so its last hop points
 * at the next document's first request; only the last document is captured.
 */
function documentNavigationHops(documents: readonly HTTPResponse[], capturedDocumentUrl: string): WebsiteNavigationHop[] {
	if (documents.length === 0) return navigationHopsFromResponse(null, capturedDocumentUrl);
	return documents.flatMap((response, position) => {
		const next = documents[position + 1];
		if (!next) return navigationHopsFromResponse(response, capturedDocumentUrl);
		const hops = navigationHopsFromResponse(response, response.url()).map((hop) => ({ ...hop, contentCaptured: false }));
		const last = hops.at(-1);
		if (last && !last.redirectTo) last.redirectTo = next.request().redirectChain()[0]?.url() ?? next.url();
		return hops;
	}).map((hop, index) => ({ ...hop, index }));
}

/**
 * Hops of what a page action opened: the documents that arrived after it (a
 * POST answered by a redirect, then the next page), or the same document again
 * when the kit swapped in its next step without navigating.
 */
function actionResultHops(arrived: readonly HTTPResponse[], current: HTTPResponse | undefined, capturedDocumentUrl: string): WebsiteNavigationHop[] {
	if (arrived.length) return documentNavigationHops(arrived, capturedDocumentUrl);
	const { redirectTo: _, ...hop } = navigationHopsFromResponse(current ?? null, capturedDocumentUrl).at(-1)!;
	return [{ ...hop, index: 0, contentCaptured: true }];
}

async function pageText(page: Page): Promise<string> {
	return page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
}

/**
 * Waits until a page action's result shows: the next document has loaded, or
 * the page's own text changed and then stayed the same for a quiet period (a
 * kit that swaps in its next step, or shows an error). A kit's own progress
 * text ("Checking…", "Opening... Connecting") changes the page before it
 * navigates, so a change only counts once it has settled, and a navigation
 * within the bound always wins. Past the bound the page is captured as it stands.
 */
async function settlePageAction(page: Page, navigated: () => boolean, textBefore: string, settle: { settleMs: number; quietMs: number }): Promise<void> {
	const deadline = Date.now() + settle.settleMs;
	let lastText = textBefore;
	let lastChangeAt: number | undefined;
	while (Date.now() < deadline) {
		await sleep(WEBSITE_GATE_POLL_MS);
		const readyState = await page.evaluate(() => document.readyState).catch(() => "loading");
		if (readyState === "loading") continue;
		if (navigated()) return;
		const text = await pageText(page);
		if (text !== lastText) {
			lastText = text;
			lastChangeAt = Date.now();
			continue;
		}
		if (lastChangeAt !== undefined && text !== textBefore && Date.now() - lastChangeAt >= settle.quietMs) return;
	}
}

/** Attempts at a screenshot that shows what the page has rendered. */
const SCREENSHOT_PAINT_ATTEMPTS = 4;

/** Whether a screenshot is one flat colour: no text, no edges, nothing drawn. */
export async function isBlankScreenshot(png: Uint8Array): Promise<boolean> {
	const { channels } = await sharp(png).stats();
	return channels.slice(0, 3).every((channel) => channel.stdev < 2);
}

/**
 * A full-page screenshot of what the page shows. Headless Chromium sometimes
 * returns a frame it has not painted yet, a blank page over a document full of
 * text (a Google Site captured right after its embedded kit navigated). When
 * the document shows text but the image is blank, wait for the next frames to
 * paint and capture again; a page that is truly empty stays blank.
 */
async function capturePaintedScreenshot(page: Page): Promise<Uint8Array> {
	const capture = () => page.screenshot({ fullPage: true, captureBeyondViewport: true, type: "png" });
	let screenshot = await capture();
	for (let attempt = 1; attempt < SCREENSHOT_PAINT_ATTEMPTS && await isBlankScreenshot(screenshot); attempt++) {
		const showsText = await page.evaluate(() => (document.body?.innerText ?? "").trim().length > 0).catch(() => false);
		if (!showsText) break;
		await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))).catch(() => undefined);
		await sleep(500 * attempt);
		screenshot = await capture();
	}
	return screenshot;
}

/** A live capture: the captured page, and the open browser the flow can keep acting in. */
type LiveCapture = { archive: WebsiteArchiveResult; session: WebsitePageSession };

async function openLiveCapture(options: ArchiveWebsiteOptions, egress: FabricEgress, dependencies: WebsiteArchiveDependencies): Promise<LiveCapture> {
	const { url, referrer } = options;
	const browser = await (dependencies.getBrowser ?? getBrowser)(egress).catch((error: unknown) => {
		throw new BrowserInfrastructureError(`Browser service unavailable: ${errorText(error)}`, { cause: error });
	});
	let open = true;
	const close = async () => {
		if (!open) return;
		open = false;
		await browser.close();
	};
	try {
		// Browser Fabric owns the leased profile context. Creating an
		// application-side incognito context would bypass that profile and egress
		// boundary, so archive work always uses the Fabric lease's default context.
		const device = options.device ?? "desktop";
		const { page, userAgent } = await getBrowserPage(await browser.defaultBrowserContext().newPage(), device);

		const kitResources = recordKitResources(page);
		const frameTraffic = recordFrameTraffic(page);
		// The last final (non-redirect) main-frame document response, so a
		// document that replaces an error interstitial is seen with its status.
		let latestDocumentResponse = null as HTTPResponse | null;
		// Every successful main-frame document the visit passed through, in order:
		// the submitted page, where its script sent the visitor (even from its
		// <head>, before the navigation resolves), what a clicked verification
		// gate navigated to, and what each page action opened. An HTTP error
		// document (a bot check that reloads into the real page) is replaced, not
		// passed through.
		const documents: HTTPResponse[] = [];
		page.on("response", (response) => {
			const request = response.request();
			const status = response.status();
			if (request.isNavigationRequest() && request.frame() === page.mainFrame() && (status < 300 || status >= 400) && isNetworkDocument(response)) {
				latestDocumentResponse = response;
				if (response.ok()) documents.push(response);
			}
		});

		// Navigation completes once the document exists; a stalled image or
		// third-party resource must not hold the entire analysis open. Fabric owns
		// browser egress, so this evidence-only navigation does not need an
		// app-level interception layer.
		let navigationResponse = await page.goto(url, {
			waitUntil: "domcontentloaded",
			timeout: WEBSITE_NAVIGATION_TIMEOUT_MS,
			// A kit's later page may check that the visitor came from its earlier one.
			...(referrer ? { referer: referrer } : {}),
		}).catch((error: unknown) => {
			// A browser that died under the navigation says nothing about the site.
			if (isBrowserInfrastructureFailure(error)) throw new BrowserInfrastructureError(errorText(error), { cause: error });
			throw new WebsiteUnreachableError(egress, errorText(error));
		});
		// A kit that swaps in its blob: page before DOMContentLoaded makes the
		// navigation resolve with that blob: document; the site's own response is
		// the document the visitor loaded.
		if (navigationResponse && !isNetworkDocument(navigationResponse)) navigationResponse = latestDocumentResponse;
		if (navigationResponse && !navigationResponse.ok()) {
			const settled = await settleErrorDocument(page, () => latestDocumentResponse, dependencies.errorDocumentSettleMs ?? WEBSITE_ERROR_DOCUMENT_SETTLE_MS);
			if (!settled) {
				const title = compactText(await page.title().catch(() => ""));
				const status = latestDocumentResponse?.status() ?? navigationResponse.status();
				throw new WebsiteUnreachableError(egress, `HTTP ${status}${title ? ` ("${title}")` : ""}`);
			}
			navigationResponse = settled;
		}

		// A cloaking interstitial loads, asks its server where to send this visitor,
		// then navigates the main frame by script. Wait for that navigation so the
		// capture holds the page the visitor ends up on, and record the scripted
		// step as its own hop. The MHTML's own Chromium URL header identifies the
		// captured document either way.
		const scriptNavigation = await settleScriptNavigation(page, () => latestDocumentResponse, navigationResponse, dependencies.scriptNavigationSettleMs ?? WEBSITE_SCRIPT_NAVIGATION_SETTLE_MS);
		// A navigation the page started that ended in an HTTP error or a network
		// failure leaves Chromium's own error document (chrome-error://) in the
		// main frame. That is not a site: the destination was unreachable.
		const loadedUrl = (scriptNavigation ?? navigationResponse)?.url() ?? url;
		if (!documentAddress(page.url(), loadedUrl)) {
			const failed = latestDocumentResponse !== navigationResponse ? latestDocumentResponse : null;
			throw new WebsiteUnreachableError(egress, failed
				? `the page sent the visitor to ${failed.request().redirectChain()[0]?.url() ?? failed.url()}, which ended in HTTP ${failed.status()} at ${failed.url()}`
				: "the page's own navigation failed before reaching a site");
		}
		const renderSettleMs = dependencies.renderSettleMs ?? WEBSITE_RENDER_SETTLE_MS;
		await settleRendering(page, renderSettleMs);
		let verificationGate = await passVerificationGate(page, renderSettleMs);

		/** The page as it stands: screenshot, MHTML, and the hops that led to it. */
		const snapshot = async (hopsTo: (capturedDocumentUrl: string) => WebsiteNavigationHop[], performedAction?: WebsitePerformedAction): Promise<WebsiteArchiveResult> => {
			const documentUrl = documents.at(-1)?.url() ?? loadedUrl;
			const screenshotUrl = documentAddress(page.url(), documentUrl);
			const screenshotBytes = await capturePaintedScreenshot(page);
			const cdp = await page.target().createCDPSession();
			const resolvedMhtml = Buffer.from((await cdp.send("Page.captureSnapshot", { format: "mhtml" })).data, "utf-8");
			const capturedDocumentUrl = getMhtmlArchiveLocation(resolvedMhtml) ?? documentAddress(page.url(), documentUrl) ?? page.url();
			const capturedDocument = await archiveMhtmlSnapshot({ url, archivedUrl: capturedDocumentUrl, navigationHops: hopsTo(capturedDocumentUrl), mhtmlSnapshot: resolvedMhtml });
			const frames = await hiddenFrames(page, frameTraffic, userAgent);
			return {
				...capturedDocument,
				route: FABRIC_EGRESS_LABEL[egress],
				screenshotPng: screenshotUrl === capturedDocumentUrl ? Buffer.from(screenshotBytes) : undefined,
				kitResources: await kitResources.settled(),
				...(frames.length ? { hiddenFrames: frames } : {}),
				...(device !== "desktop" ? { device } : {}),
				...(verificationGate ? { verificationGate } : {}),
				...(performedAction ? { performedAction } : {}),
			};
		};

		const act = async (action: WebsitePageAction): Promise<WebsiteArchiveResult> => {
			if (!open) throw new Error("The capture's browser is already closed.");
			// The hops of what the action opened start at its response; the pages
			// before it were captured as earlier steps.
			const resultDocumentsFrom = documents.length;
			const textBefore = await pageText(page);
			let performedAction: WebsitePerformedAction;
			try {
				performedAction = await performPageAction(page, action, { humanCheckMs: dependencies.humanCheckMs, captchaProviderFrame: dependencies.captchaProviderFrame });
			} catch (error) {
				if (!(error instanceof WebsitePageActionTargetMissingError)) throw error;
				const reason = new WebsiteUnreachableError(egress, error.message);
				console.warn(`Website action on ${page.url()} failed: ${reason.message}`);
				throw new WebsiteCaptureFailedError([reason]);
			}
			await settlePageAction(page, () => documents.length > resultDocumentsFrom, textBefore, {
				settleMs: dependencies.pageActionSettleMs ?? WEBSITE_PAGE_ACTION_SETTLE_MS,
				quietMs: dependencies.pageActionQuietMs ?? WEBSITE_PAGE_ACTION_QUIET_MS,
			});
			await settleRendering(page, renderSettleMs);
			verificationGate = await passVerificationGate(page, renderSettleMs) ?? verificationGate;
			return snapshot((capturedDocumentUrl) => actionResultHops(documents.slice(resultDocumentsFrom), documents.at(-1), capturedDocumentUrl), performedAction);
		};

		const archive = await snapshot((capturedDocumentUrl) => documentNavigationHops(documents, capturedDocumentUrl));
		return { archive, session: { act, close } };
	} catch (error) {
		await close();
		throw error;
	}
}

/**
 * Capture the page over the first route that reaches it and, when its script
 * sends Tor and datacenter visitors to another site, once more from the
 * residential exit. With `keepSession`, the browser of the capture returned
 * stays open as its `session`, and the caller closes it; every other capture's
 * browser is closed here.
 */
export async function archiveWebsite(options: ArchiveWebsiteOptions, dependencies: WebsiteArchiveDependencies = {}): Promise<WebsiteArchiveResult> {
	const { url, mhtmlSnapshot } = options;
	console.log(`Archiving website ${url}`);
	if (mhtmlSnapshot?.byteLength) {
		return archiveMhtmlSnapshot({ ...options, mhtmlSnapshot });
	}

	const opened: LiveCapture[] = [];
	const capture = async (egress: FabricEgress) => {
		const live = await openLiveCapture(options, egress, dependencies);
		opened.push(live);
		return live.archive;
	};
	let returned: WebsiteArchiveResult | undefined;
	const keep = (archive: WebsiteArchiveResult, result: WebsiteArchiveResult = archive): WebsiteArchiveResult => {
		const session = opened.find((live) => live.archive === archive)?.session;
		returned = archive;
		return options.keepSession && session ? { ...result, session } : result;
	};
	try {
		const failures: WebsiteUnreachableError[] = [];
		let decoy: { archive: WebsiteArchiveResult; site: string; egress: FabricEgress } | undefined;
		for (const egress of WEBSITE_CAPTURE_EGRESS) {
			try {
				const archive = await capture(egress);
				const site = scriptDestinationSite(archive);
				if (!site) return keep(archive);
				console.warn(`Website capture of ${url} via ${FABRIC_EGRESS_LABEL[egress]}: the page sent the visitor to ${site} by script`);
				decoy = { archive, site, egress };
				break;
			} catch (error) {
				if (!(error instanceof WebsiteUnreachableError)) throw error;
				console.warn(`Website capture of ${url} failed: ${error.message}`);
				failures.push(error);
			}
		}

		// A scripted jump to another site, or no page at all, is how cloakers answer
		// Tor and datacenter visitors. Ask once more as a residential visitor would.
		let residential: WebsiteArchiveResult | undefined;
		try {
			residential = await capture(WEBSITE_CLOAKING_EGRESS);
		} catch (error) {
			// The residential exit depends on the operator's machine being online; its
			// failure must not hide what the other routes captured.
			const reason = error instanceof WebsiteUnreachableError ? error : new WebsiteUnreachableError(WEBSITE_CLOAKING_EGRESS, errorText(error));
			console.warn(`Website capture of ${url} failed: ${reason.message}`);
			failures.push(reason);
		}

		if (residential) {
			const residentialSite = scriptDestinationSite(residential);
			// The same scripted destination for every route is either an ordinary
			// redirect or a cloaker that turns all of them away; the destination's
			// own verdict tells them apart.
			if (decoy && residentialSite === decoy.site) {
				return keep(decoy.archive, {
					...decoy.archive,
					cloaking: {
						outcome: "uniform",
						detail: `${url} sent both the ${FABRIC_EGRESS_LABEL[decoy.egress]} and the ${FABRIC_EGRESS_LABEL[WEBSITE_CLOAKING_EGRESS]} to ${decoy.site} by script`,
					},
				});
			}
			if (!decoy) return keep(residential);
			const reached = residentialSite ?? siteOf(residential.url);
			return keep(residential, {
				...residential,
				cloaking: {
					outcome: "detected",
					detail: `${url} sent the ${FABRIC_EGRESS_LABEL[decoy.egress]} to ${decoy.site} but the ${FABRIC_EGRESS_LABEL[WEBSITE_CLOAKING_EGRESS]} to ${reached}`,
				},
			});
		}
		if (decoy) {
			return keep(decoy.archive, {
				...decoy.archive,
				cloaking: {
					outcome: "unresolved",
					detail: `${url} sent the ${FABRIC_EGRESS_LABEL[decoy.egress]} to ${decoy.site} by script; the ${FABRIC_EGRESS_LABEL[WEBSITE_CLOAKING_EGRESS]} capture failed: ${failures.at(-1)?.message ?? "unavailable"}`,
				},
			});
		}
		throw new WebsiteCaptureFailedError(failures);
	} finally {
		for (const live of opened) {
			if (!options.keepSession || live.archive !== returned) await live.session.close();
		}
	}
}
