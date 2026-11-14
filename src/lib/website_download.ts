import type { CDPSession, Page } from "rebrowser-puppeteer-core";

import { CONTINUATION_CONTROL_SELECTOR } from "./website_fields";
import type { WebsiteDownloadTarget } from "./website_types";

/**
 * Getting the file a page offers, in the visit that captured it: the page's
 * own download button is clicked (or its download link followed) as a
 * visitor would, with the same cookies and the same Cloudflare clearance.
 * The browser never saves or opens the file: its response is held at the
 * network layer, its body taken, and the download aborted.
 */

/** A file larger than this is not read; a kit's stealer is small, and an installer this big is reported by size only. */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_WAIT_MS = 15_000;
/** A button that only opens a download dialog gets one more click, on the control the dialog shows. */
const DIALOG_CONTROL = /download|install|get|continue|confirm|proceed|start|^ok$|^yes/i;

export type DownloadedFile = { url: string; fileName: string; contentType?: string; bytes: Buffer };

/** The page's download step did not deliver a file: no download started, or the file could not be read. */
export class WebsiteDownloadFailedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WebsiteDownloadFailedError";
	}
}

type Header = { name: string; value: string };
type PausedResponse = { requestId: string; request: { url: string }; responseStatusCode?: number; responseHeaders?: Header[] };

function header(headers: readonly Header[] | undefined, name: string): string | undefined {
	return headers?.find((candidate) => candidate.name.toLowerCase() === name)?.value;
}

/** The file name a download is saved as: the server's, else the URL's last segment. */
export function downloadFileName(url: string, disposition: string | undefined, suggested?: string): string {
	const encoded = disposition?.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/)?.[1];
	const plain = disposition?.match(/filename\s*=\s*"?([^";]+)"?/)?.[1];
	let name = suggested;
	try {
		name = (encoded ? decodeURIComponent(encoded) : plain) ?? suggested ?? decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
	} catch {
		name = plain ?? suggested;
	}
	return name?.replace(/[\\/\u0000-\u001f]/g, "_").trim().slice(0, 200) || "download";
}

/** A response the browser saves rather than shows: an attachment, or anything that is not a page. */
function isDownloadResponse(paused: PausedResponse): boolean {
	if (/^\s*attachment/i.test(header(paused.responseHeaders, "content-disposition") ?? "")) return true;
	const status = paused.responseStatusCode ?? 0;
	if (status < 200 || status >= 300) return false;
	const type = header(paused.responseHeaders, "content-type") ?? "";
	return !/^\s*(?:text\/html|application\/xhtml\+xml|text\/plain)?\s*(?:;|$)/i.test(type);
}

/** Runs in the page: marks the control captioned `label` (shown first, else hidden), so it can be clicked. */
function markControl(selector: string, label: string, mark: string): "shown" | "hidden" | undefined {
	const caption = (element: Element) => {
		const value = element.tagName.toLowerCase() === "input" ? element.getAttribute("value") : undefined;
		for (const candidate of [element.textContent, value, element.getAttribute("aria-label"), element.getAttribute("title")]) {
			const compact = candidate?.replace(/\s+/g, " ").trim();
			if (compact) return compact.slice(0, 120);
		}
		return undefined;
	};
	// A control a visitor can click: the point at its centre lands on it. A dialog
	// that is closed by its container's opacity and pointer-events is not shown,
	// though each of its buttons, by its own style, is.
	const shown = (element: Element) => {
		element.scrollIntoView({ block: "center", inline: "center" });
		const box = element.getBoundingClientRect();
		if (box.width <= 4 || box.height <= 4) return false;
		const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
		return Boolean(hit && (hit === element || element.contains(hit)));
	};
	const matches = [...document.querySelectorAll(selector)].filter((element) => caption(element) === label && !element.hasAttribute("disabled"));
	const element = matches.find(shown) ?? matches[0];
	document.querySelectorAll(`[${mark}]`).forEach((other) => other.removeAttribute(mark));
	if (!element) return undefined;
	element.setAttribute(mark, "");
	return shown(element) ? "shown" : "hidden";
}

/** Runs in the page: captions of the controls a visitor sees now. */
function shownCaptions(selector: string): string[] {
	return [...document.querySelectorAll(selector)].flatMap((element) => {
		const box = element.getBoundingClientRect();
		if (box.width <= 4 || box.height <= 4 || element.hasAttribute("disabled")) return [];
		// Only a control the point at its centre lands on is one a visitor can click.
		const inView = box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth;
		const hit = inView ? document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) : null;
		if (inView ? !hit || (hit !== element && !element.contains(hit)) : getComputedStyle(element).visibility === "hidden") return [];
		const caption = (element.textContent ?? element.getAttribute("value") ?? element.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
		return caption ? [caption] : [];
	});
}

const MARK = "data-ps-download";

/**
 * Press the control captioned `label`. A shown one is clicked with the mouse;
 * one in a dialog not yet open is clicked by script, which runs the same
 * handler a visitor's click would.
 */
async function pressControl(page: Page, label: string): Promise<boolean> {
	const state = await page.evaluate(markControl, CONTINUATION_CONTROL_SELECTOR, label, MARK);
	if (!state) return false;
	if (state === "shown") await page.click(`[${MARK}]`, { delay: 60 + Math.round(Math.random() * 80) });
	else await page.$eval(`[${MARK}]`, (element) => (element as HTMLElement).click());
	return true;
}

/** Follow a download link in the page itself, so the request carries its cookies and Referer. */
async function followLink(page: Page, url: string): Promise<void> {
	await page.evaluate((href) => {
		const link = document.createElement("a");
		link.href = href;
		link.download = "";
		document.body.append(link);
		link.click();
		link.remove();
	}, url);
}

/** Read a blob: or data: file the page's script built, inside the page. */
async function readInPage(page: Page, url: string): Promise<{ bytes: Buffer; contentType?: string }> {
	const read = await page.evaluate(async (href, limit) => {
		const response = await fetch(href);
		const blob = await response.blob();
		if (blob.size > limit) return { tooLarge: blob.size };
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let binary = "";
		for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
		return { base64: btoa(binary), type: blob.type };
	}, url, MAX_DOWNLOAD_BYTES);
	if ("tooLarge" in read) throw new WebsiteDownloadFailedError(`the file is ${read.tooLarge} bytes, more than the ${MAX_DOWNLOAD_BYTES} bytes the capture reads`);
	return { bytes: Buffer.from(read.base64!, "base64"), ...(read.type ? { contentType: read.type } : {}) };
}

/** Watches one tab for the download a step starts and takes its file. */
function watchDownload(page: Page, cdp: CDPSession) {
	let settle: (result: DownloadedFile | Error) => void = () => undefined;
	const result = new Promise<DownloadedFile | Error>((resolve) => { settle = resolve; });
	let opened: string | undefined;

	cdp.on("Fetch.requestPaused", async (paused: PausedResponse) => {
		try {
			if (!isDownloadResponse(paused)) {
				if (paused.responseStatusCode && paused.responseStatusCode < 300) opened = paused.request.url;
				await cdp.send("Fetch.continueRequest", { requestId: paused.requestId });
				return;
			}
			const length = Number(header(paused.responseHeaders, "content-length"));
			if (length > MAX_DOWNLOAD_BYTES) {
				settle(new WebsiteDownloadFailedError(`the file at ${paused.request.url} is ${length} bytes, more than the ${MAX_DOWNLOAD_BYTES} bytes the capture reads`));
			} else {
				const body = await cdp.send("Fetch.getResponseBody", { requestId: paused.requestId });
				const bytes = Buffer.from(body.body, body.base64Encoded ? "base64" : "utf8");
				const contentType = header(paused.responseHeaders, "content-type");
				settle({
					url: paused.request.url,
					fileName: downloadFileName(paused.request.url, header(paused.responseHeaders, "content-disposition")),
					...(contentType ? { contentType } : {}),
					bytes,
				});
			}
			// The browser never saves the file.
			await cdp.send("Fetch.failRequest", { requestId: paused.requestId, errorReason: "Aborted" });
		} catch (error) {
			settle(error instanceof Error ? error : new Error(String(error)));
		}
	});
	// A file the page's script built never touches the network.
	cdp.on("Page.downloadWillBegin", async (event: { url: string; suggestedFilename: string }) => {
		if (!/^(?:blob|data):/i.test(event.url)) return;
		try {
			const read = await readInPage(page, event.url);
			settle({ url: event.url.slice(0, 300), fileName: downloadFileName(event.url, undefined, event.suggestedFilename), ...read });
		} catch (error) {
			settle(error instanceof Error ? error : new Error(String(error)));
		}
	});

	return {
		/** The file, or undefined when no download started within `waitMs`. */
		next: async (waitMs: number): Promise<DownloadedFile | undefined> => {
			let timer: Parameters<typeof clearTimeout>[0];
			const outcome = await Promise.race([result, new Promise<undefined>((resolve) => { timer = setTimeout(resolve, waitMs); })]).finally(() => clearTimeout(timer));
			if (outcome instanceof Error) throw outcome;
			return outcome;
		},
		/** The page a step opened instead of a file, if any. */
		get opened() { return opened; },
	};
}

/**
 * Take the page's download step and return the file it delivers, unread by
 * the browser. A button that opens a dialog instead is followed by one click
 * on the download control the dialog shows.
 */
export async function downloadOfferedFile(page: Page, target: WebsiteDownloadTarget, options: { waitMs?: number } = {}): Promise<DownloadedFile> {
	const waitMs = options.waitMs ?? DOWNLOAD_WAIT_MS;
	const cdp = await page.target().createCDPSession();
	try {
		await cdp.send("Page.enable");
		await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Response" }] });
		// Files built by script would otherwise be saved; no download reaches the browser's disk.
		await cdp.send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: true }).catch(() => undefined);
		const watch = watchDownload(page, cdp);

		if (target.kind === "link") {
			await followLink(page, target.link.url);
			const file = await watch.next(waitMs);
			if (file) return file;
			throw new WebsiteDownloadFailedError(watch.opened ? `the link opened the page ${watch.opened}, not a file` : "the link started no download");
		}
		const before = new Set(await page.evaluate(shownCaptions, CONTINUATION_CONTROL_SELECTOR));
		if (!await pressControl(page, target.control.label)) throw new WebsiteDownloadFailedError(`the page showed no button "${target.control.label}"`);
		const file = await watch.next(waitMs);
		if (file) return file;
		if (watch.opened) throw new WebsiteDownloadFailedError(`the button opened the page ${watch.opened}, not a file`);
		// The button opened a dialog: its own download control is the step that delivers the file.
		const revealed = (await page.evaluate(shownCaptions, CONTINUATION_CONTROL_SELECTOR)).find((caption) => !before.has(caption) && DIALOG_CONTROL.test(caption));
		if (revealed && await pressControl(page, revealed)) {
			const fromDialog = await watch.next(waitMs);
			if (fromDialog) return fromDialog;
		}
		throw new WebsiteDownloadFailedError(`the button "${target.control.label}" started no download${revealed ? `, nor did "${revealed}" in what it opened` : ""}`);
	} finally {
		await cdp.send("Fetch.disable").catch(() => undefined);
		await cdp.detach().catch(() => undefined);
	}
}
