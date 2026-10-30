import { type HTTPRequest, type HTTPResponse, type Page, TimeoutError } from "rebrowser-puppeteer-core";
import { getDomain } from "tldts";

import { getBrowser, getBrowserPage } from "./browser";
import type { FabricEgress } from "./browser/fabric";
import { sleep } from "./utils";
import type { WebsiteNavigationHop } from "./website_types";
// @ts-ignore
import { convert } from "mhtml-to-html";
import parse, { HTMLElement } from "node-html-parser";

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
	/**
	 * How the capture handled a cloaker: a page whose own script sends Tor and
	 * datacenter visitors to a different site than a residential visitor.
	 * `detected`: the residential exit reached a different site, which this
	 * archive holds. `unresolved`: only the decoy could be captured.
	 */
	cloaking?: { outcome: "detected" | "unresolved"; detail: string };
	/** URL whose document body, screenshot, and MHTML are captured. */
	url: string;
	hostname: string;
	navigationHops: WebsiteNavigationHop[];
	/** Timestamp embedded in the MHTML capture, or the capture time when it is not available. */
	archivedAt: Date;
	screenshotPng?: Buffer;
	mhtml: Buffer;
	html: Buffer;
	text: Buffer;
	/** Non-empty when an uploaded snapshot claims a different host than the submitted target. */
	attributionError?: string;
};

const WEBSITE_NAVIGATION_TIMEOUT_MS = 30_000;

export type ArchiveWebsiteOptions = {
	/** Raw MHTML (decoded bytes). It is parsed locally; Fabric browsers never receive an app-local file:// URL. */
	mhtmlSnapshot?: Buffer;
	/** Original user-submitted URL. */
	url: string;
	/** Original location represented by the retained MHTML document, when known. */
	archivedUrl?: string;
	/** Exact response hops associated with the retained MHTML document, when known. */
	navigationHops?: WebsiteNavigationHop[];
	/** Only true for MHTML read back from this service's own stored artifact. */
	trustMhtmlDocumentLocation?: boolean;
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
	const declaredHost = declaredDocumentUrl ? new URL(declaredDocumentUrl).hostname : undefined;
	const attributionError = !options.archivedUrl && !options.trustMhtmlDocumentLocation && declaredHost && declaredHost !== requestedUrl.hostname
		? `The uploaded MHTML declares ${declaredHost}, but the submitted target is ${requestedUrl.hostname}.`
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

/** Sanitized HTML and visitor-readable text of a captured document. */
export function capturedDocumentContent(documentHtml: string): { html: string; text: string } {
	const dom = parse(documentHtml);
	dom.querySelectorAll("script, style, link, svg, noscript").forEach((element) => element.remove());
	dom.querySelectorAll("*").forEach((element) => element.removeAttribute("style"));
	const textDom = parse(dom.outerHTML);
	inlineAttributeText(textDom);
	dom.querySelectorAll("img").forEach((element) => element.remove());
	const title = dom.querySelector("title")?.textContent ?? "";
	const description = dom.querySelector("meta[name='description'], meta[property='og:description'], meta[property='twitter:description']")?.getAttribute("content") ?? "";
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
const WEBSITE_EGRESS_LABEL: Record<FabricEgress, string> = { phishing: "Tor exit", reporting: "server IP", residential: "residential exit" };

/** How long an HTTP error document may take to replace itself, e.g. a JavaScript bot-check interstitial. */
const WEBSITE_ERROR_DOCUMENT_SETTLE_MS = 20_000;
const WEBSITE_ERROR_DOCUMENT_POLL_MS = 500;
/** How long a loaded page may take before its own script navigates the main frame elsewhere. */
const WEBSITE_SCRIPT_NAVIGATION_SETTLE_MS = 8_000;
/** How long the captured document may keep fetching what it renders before it is captured as it stands. */
const WEBSITE_RENDER_SETTLE_MS = 10_000;
/** A quiet network for this long means the page's script has fetched what it renders. */
const WEBSITE_RENDER_IDLE_MS = 1_000;
/** Requests that may stay open while the page counts as rendered: analytics beacons, long polls, captcha widgets. */
const WEBSITE_RENDER_IDLE_CONCURRENCY = 2;

/**
 * The site's main document could not be loaded over one egress route: the
 * navigation failed, or it answered with an HTTP error that did not resolve itself.
 */
export class WebsiteUnreachableError extends Error {
	constructor(readonly egress: FabricEgress, readonly reason: string) {
		super(`${reason} via ${WEBSITE_EGRESS_LABEL[egress]}`);
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
	const submittedSite = siteOf(archive.requestedUrl);
	const capturedSite = siteOf(archive.url);
	if (capturedSite === submittedSite) return undefined;
	const httpRedirectOffSite = archive.navigationHops.some((hop) => hop.status !== null && hop.status >= 300 && hop.status < 400 && hop.redirectTo && siteOf(hop.redirectTo) !== submittedSite);
	return httpRedirectOffSite ? undefined : capturedSite;
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

/** Hops of the loaded page followed by the hops of the document its script navigated to. */
function scriptNavigationHops(loadedResponse: HTTPResponse | null, scriptResponse: HTTPResponse, capturedDocumentUrl: string): WebsiteNavigationHop[] {
	const loadedUrl = loadedResponse?.url() ?? capturedDocumentUrl;
	const loaded = navigationHopsFromResponse(loadedResponse, loadedUrl).map((hop) => ({ ...hop, contentCaptured: false }));
	const last = loaded.at(-1);
	if (last && !last.redirectTo) last.redirectTo = scriptResponse.request().redirectChain()[0]?.url() ?? scriptResponse.url();
	const followed = navigationHopsFromResponse(scriptResponse, capturedDocumentUrl);
	return [...loaded, ...followed].map((hop, index) => ({ ...hop, index }));
}

async function captureLiveWebsite(url: string, egress: FabricEgress, dependencies: WebsiteArchiveDependencies): Promise<WebsiteArchiveResult> {
	const browser = await (dependencies.getBrowser ?? getBrowser)(egress);
	try {
		// Browser Fabric owns the leased profile context. Creating an
		// application-side incognito context would bypass that profile and egress
		// boundary, so archive work always uses the Fabric lease's default context.
		const { page } = await getBrowserPage(await browser.defaultBrowserContext().newPage());

		// The last final (non-redirect) main-frame document response, so a
		// document that replaces an error interstitial is seen with its status.
		let latestDocumentResponse = null as HTTPResponse | null;
		page.on("response", (response) => {
			const request = response.request();
			const status = response.status();
			// Only network documents: Chromium's own chrome-error:// page is not a site response.
			if (request.isNavigationRequest() && request.frame() === page.mainFrame() && (status < 300 || status >= 400) && /^https?:/i.test(response.url())) {
				latestDocumentResponse = response;
			}
		});

		// Navigation completes once the document exists; a stalled image or
		// third-party resource must not hold the entire analysis open. Fabric owns
		// browser egress, so this evidence-only navigation does not need an
		// app-level interception layer.
		let navigationResponse = await page.goto(url, {
			waitUntil: "domcontentloaded",
			timeout: WEBSITE_NAVIGATION_TIMEOUT_MS,
		}).catch((error: unknown) => {
			throw new WebsiteUnreachableError(egress, error instanceof Error ? error.message : String(error));
		});
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
		if (!/^https?:$/i.test(new URL(page.url()).protocol)) {
			const failed = latestDocumentResponse !== navigationResponse ? latestDocumentResponse : null;
			throw new WebsiteUnreachableError(egress, failed
				? `the page sent the visitor to ${failed.request().redirectChain()[0]?.url() ?? failed.url()}, which ended in HTTP ${failed.status()} at ${failed.url()}`
				: "the page's own navigation failed before reaching a site");
		}
		await settleRendering(page, dependencies.renderSettleMs ?? WEBSITE_RENDER_SETTLE_MS);
		const screenshotUrl = page.url();
		const screenshotBytes = await page.screenshot({
			fullPage: true,
			captureBeyondViewport: true,
			type: "png",
		});
		const cdp = await page.target().createCDPSession();
		const resolvedMhtml = Buffer.from(
			(
				await cdp.send("Page.captureSnapshot", {
					format: "mhtml",
				})
			).data,
			"utf-8",
		);

		const capturedDocumentUrl = getMhtmlArchiveLocation(resolvedMhtml) ?? page.url();
		const capturedDocument = await archiveMhtmlSnapshot({
			url,
			archivedUrl: capturedDocumentUrl,
			navigationHops: scriptNavigation
				? scriptNavigationHops(navigationResponse, scriptNavigation, capturedDocumentUrl)
				: navigationHopsFromResponse(navigationResponse, capturedDocumentUrl),
			mhtmlSnapshot: resolvedMhtml,
		});
		const screenshotPng = screenshotUrl === capturedDocumentUrl ? Buffer.from(screenshotBytes) : undefined;

		return {
			...capturedDocument,
			screenshotPng,
		};
	} finally {
		await browser.close();
	}
}

export async function archiveWebsite(options: ArchiveWebsiteOptions, dependencies: WebsiteArchiveDependencies = {}): Promise<WebsiteArchiveResult> {
	const { url, mhtmlSnapshot, archivedUrl, navigationHops, trustMhtmlDocumentLocation } = options;
	console.log(`Archiving website ${url}`);
	if (mhtmlSnapshot?.byteLength) {
		return archiveMhtmlSnapshot({ url, mhtmlSnapshot, archivedUrl, navigationHops, trustMhtmlDocumentLocation });
	}

	const failures: WebsiteUnreachableError[] = [];
	let decoy: { archive: WebsiteArchiveResult; site: string; egress: FabricEgress } | undefined;
	for (const egress of WEBSITE_CAPTURE_EGRESS) {
		try {
			const archive = await captureLiveWebsite(url, egress, dependencies);
			const site = scriptDestinationSite(archive);
			if (!site) return archive;
			console.warn(`Website capture of ${url} via ${WEBSITE_EGRESS_LABEL[egress]}: the page sent the visitor to ${site} by script`);
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
		residential = await captureLiveWebsite(url, WEBSITE_CLOAKING_EGRESS, dependencies);
	} catch (error) {
		// The residential exit depends on the operator's machine being online; its
		// failure must not hide what the other routes captured.
		const reason = error instanceof WebsiteUnreachableError ? error : new WebsiteUnreachableError(WEBSITE_CLOAKING_EGRESS, error instanceof Error ? error.message : String(error));
		console.warn(`Website capture of ${url} failed: ${reason.message}`);
		failures.push(reason);
	}

	if (residential) {
		const residentialSite = scriptDestinationSite(residential);
		// The same scripted destination for every visitor is an ordinary redirect.
		if (decoy && residentialSite === decoy.site) return decoy.archive;
		if (!decoy) return residential;
		const reached = residentialSite ?? siteOf(residential.url);
		return {
			...residential,
			cloaking: {
				outcome: "detected",
				detail: `${url} sent the ${WEBSITE_EGRESS_LABEL[decoy.egress]} to ${decoy.site} but the ${WEBSITE_EGRESS_LABEL[WEBSITE_CLOAKING_EGRESS]} to ${reached}`,
			},
		};
	}
	if (decoy) {
		return {
			...decoy.archive,
			cloaking: {
				outcome: "unresolved",
				detail: `${url} sent the ${WEBSITE_EGRESS_LABEL[decoy.egress]} to ${decoy.site} by script; the ${WEBSITE_EGRESS_LABEL[WEBSITE_CLOAKING_EGRESS]} capture failed: ${failures.at(-1)?.message ?? "unavailable"}`,
			},
		};
	}
	throw new Error(`Failed to load page: ${failures.map((error) => error.message).join("; ")}`);
}
