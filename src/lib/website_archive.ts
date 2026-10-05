import { getBrowser, getBrowserPage } from "./browser";
import { sleep } from "./utils";
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
	url: string;
	hostname: string;
	/** Timestamp embedded in the MHTML capture, or the capture time when it is not available. */
	archivedAt: Date;
	screenshotPng?: Buffer;
	mhtml: Buffer;
	html: Buffer;
	text: Buffer;
};

export type ArchiveWebsiteOptions = {
	/** Raw MHTML (decoded bytes). It is parsed locally; Fabric browsers never receive an app-local file:// URL. */
	mhtmlSnapshot?: Buffer;
	/** Original remote URL (used for hostname/labeling when loading a local MHTML snapshot). */
	url: string;
};

/**
 * Reads the top-level MHTML Date header emitted by Chromium's snapshot writer.
 * MIME parts can contain their own headers, so only inspect the message preamble.
 */
export function getMhtmlArchiveDate(snapshot: Buffer): Date | undefined {
	const crlfHeaderEnd = snapshot.indexOf("\r\n\r\n");
	const lfHeaderEnd = snapshot.indexOf("\n\n");
	const headerEnd = crlfHeaderEnd >= 0 ? crlfHeaderEnd : lfHeaderEnd;
	const preamble = snapshot
		.subarray(0, headerEnd < 0 ? snapshot.byteLength : headerEnd)
		.toString("latin1")
		.replace(/\r?\n[\t ]+/g, " ");
	const value = preamble.match(/^Date:\s*(.+)$/im)?.[1]?.trim();
	if (!value) return undefined;

	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
}

async function archiveMhtmlSnapshot(url: string, mhtml: Buffer): Promise<WebsiteArchiveResult> {
	const { hostname } = new URL(url);
	const { data } = await convert(mhtml, {
		enableScripts: false,
		fetchMissingResources: false,
	});
	const dom = parse(data);
	dom.querySelectorAll("script, style, link, svg, noscript, img").forEach((element) => element.remove());
	dom.querySelectorAll("*").forEach((element) => element.removeAttribute("style"));
	return {
		url,
		hostname,
		archivedAt: getMhtmlArchiveDate(mhtml) ?? new Date(),
		mhtml,
		html: Buffer.from(dom.outerHTML, "utf-8"),
		text: Buffer.from(dom.structuredText, "utf-8"),
	};
}

async function archiveWebsiteInternal({ url, mhtmlSnapshot }: ArchiveWebsiteOptions): Promise<WebsiteArchiveResult> {
	console.log(`Archiving website ${url}`);
	if (mhtmlSnapshot?.byteLength) return archiveMhtmlSnapshot(url, mhtmlSnapshot);

	const browser = await getBrowser();
	try {
		// Browser Fabric owns the leased profile context. Creating an
		// application-side incognito context would bypass that profile and egress
		// boundary, so archive work always uses the Fabric lease's default context.
		const newPage = await browser.defaultBrowserContext().newPage();

		const { page } = await getBrowserPage(newPage);

		const uri = new URL(url);
		const { hostname } = uri;

		await page.setRequestInterception(true);

		page.on("response", (response) => {
			if (!response.request().isNavigationRequest()) return;
			try {
				const uri = new URL(response.url());
				if (hostname !== uri.hostname) {
					// reject(new Error("Redirected to different hostname"));
				}
			} catch {
				// ignore
			}
		});

		page.on("request", (request) => {
			console.log(`Request: ${request.method()} ${request.url()}`);
			return request.continue();
		});

		try {
			const response = await page.goto(url, {
				waitUntil: "load",
				timeout: 1000 * 120,
			});

			if (response && !response.ok()) {
				throw new Error(`Failed to load page, status code: ${response.status()}`);
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

		await sleep(1000 * 5); // wait for additional content to load

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

		return {
			url: url,
			hostname,
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

export async function archiveWebsite(options: ArchiveWebsiteOptions): Promise<WebsiteArchiveResult> {
	return archiveWebsiteInternal(options);
}
