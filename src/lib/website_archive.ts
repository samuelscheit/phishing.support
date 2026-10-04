import type { HTTPRequest, HTTPResponse } from "rebrowser-puppeteer-core";

import { getBrowser, getBrowserPage } from "./browser";
import { sleep } from "./utils";
import type { WebsiteNavigationHop } from "./submissions/website_types";
// @ts-ignore
import { convert } from "mhtml-to-html";
import parse from "node-html-parser";

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
	const documentUrl = options.archivedUrl ?? getMhtmlArchiveLocation(options.mhtmlSnapshot) ?? options.url;
	const { hostname } = new URL(documentUrl);
	const navigationHops = options.navigationHops?.length
		? options.navigationHops
		: documentUrl === options.url
			? [{ index: 0, url: documentUrl, hostname, status: null, contentCaptured: true }]
			: [
					{ index: 0, url: options.url, hostname: new URL(options.url).hostname, status: null, redirectTo: documentUrl, contentCaptured: false },
					{ index: 1, url: documentUrl, hostname, status: null, contentCaptured: true },
				];
	const { data } = await convert(options.mhtmlSnapshot, {
		enableScripts: false,
		fetchMissingResources: false,
	});
	const dom = parse(data);
	dom.querySelectorAll("script, style, link, svg, noscript, img").forEach((element) => element.remove());
	dom.querySelectorAll("*").forEach((element) => element.removeAttribute("style"));
	return {
		requestedUrl: options.url,
		url: documentUrl,
		hostname,
		navigationHops,
		archivedAt: getMhtmlArchiveDate(options.mhtmlSnapshot) ?? new Date(),
		mhtml: options.mhtmlSnapshot,
		html: Buffer.from(dom.outerHTML, "utf-8"),
		text: Buffer.from(dom.structuredText, "utf-8"),
	};
}

export type WebsiteArchiveDependencies = {
	browser?: Awaited<ReturnType<typeof getBrowser>>;
	sleep?: typeof sleep;
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

	return requests.map((request: HTTPRequest, index) => {
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
			contentCaptured: index === requests.length - 1,
		};
	});
}

async function archiveWebsiteInternal(
	{ url, mhtmlSnapshot, archivedUrl, navigationHops: retainedNavigationHops }: ArchiveWebsiteOptions,
	dependencies: WebsiteArchiveDependencies = {},
): Promise<WebsiteArchiveResult> {
	console.log(`Archiving website ${url}`);
	if (mhtmlSnapshot?.byteLength) {
		return archiveMhtmlSnapshot({ url, mhtmlSnapshot, archivedUrl, navigationHops: retainedNavigationHops });
	}

	const browser = dependencies.browser ?? await getBrowser();
	try {
		// Browser Fabric owns the leased profile context. Creating an
		// application-side incognito context would bypass that profile and egress
		// boundary, so archive work always uses the Fabric lease's default context.
		const newPage = await browser.defaultBrowserContext().newPage();

		const { page } = await getBrowserPage(newPage);

		let navigationResponse: HTTPResponse | null = null;
		let finalUrl = url;

		try {
			// Capture once the document exists; a stalled image or third-party resource
			// must not hold the entire analysis open. Fabric owns browser egress, so this
			// evidence-only navigation does not need an app-level interception layer.
			navigationResponse = await page.goto(url, {
				waitUntil: "domcontentloaded",
				timeout: WEBSITE_NAVIGATION_TIMEOUT_MS,
			});
			finalUrl = navigationResponse?.url() ?? page.url();

			if (navigationResponse && !navigationResponse.ok()) {
				throw new Error(`Failed to load page, status code: ${navigationResponse.status()}`);
			}
		} catch (err) {
			await page
				.screenshot({
					fullPage: true,
					captureBeyondViewport: true,
					type: "png",
				})
				.catch((screenshotError) => {
					console.warn(`Failed to capture archive error screenshot:`, screenshotError);
				});

			throw err;
		}

		await (dependencies.sleep ?? sleep)(1000 * 5); // allow brief post-DOM content hydration

		const screenshotPng = await page.screenshot({
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

		const rawHtml = await page.evaluate(() => {
			const doc = globalThis.document.cloneNode(true) as Document;
			const elements = doc.querySelectorAll("script, style, link, svg, noscript, img");
			elements.forEach((element) => element.remove());
			doc.querySelectorAll("*").forEach((element) => element.removeAttribute("style"));
			return doc.documentElement.outerHTML;
		});

		let innerText = await page.evaluate(() => globalThis.document.body.innerText);
		const description = await page.evaluate(() => (
			globalThis.document
				.querySelector("meta[name='description'], meta[property='og:description'], meta[property='twitter:description']")
				?.getAttribute("content") || ""
		));
		innerText = ((await page.title()) + "\n\n" + description + "\n\n" + innerText)
			.replaceAll(/ +/g, " ")
			.replaceAll(/\n+/g, "\n")
			.trim();

		const archivedAt = getMhtmlArchiveDate(resolvedMhtml) ?? new Date();
		const navigationHops = navigationHopsFromResponse(navigationResponse, finalUrl);
		const { hostname } = new URL(finalUrl);

		return {
			requestedUrl: url,
			url: finalUrl,
			hostname,
			navigationHops,
			archivedAt,
			screenshotPng: Buffer.from(screenshotPng),
			mhtml: resolvedMhtml,
			html: Buffer.from(rawHtml, "utf-8"),
			text: Buffer.from(innerText, "utf-8"),
		};
	} finally {
		await browser.close();
	}
}

export async function archiveWebsite(options: ArchiveWebsiteOptions, dependencies: WebsiteArchiveDependencies = {}): Promise<WebsiteArchiveResult> {
	return archiveWebsiteInternal(options, dependencies);
}
