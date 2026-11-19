import type { CDPSession, Page } from "rebrowser-puppeteer-core";

import { sendBeforeRun } from "./browser/cdp";

/**
 * Every file a visit downloads, taken without the browser ever saving or
 * opening it: a download response is held at the network layer, its body
 * read, and the download aborted. A file the page's script builds (`blob:`)
 * is read inside the page.
 */

/** A file larger than this is not read; a kit's stealer is small, and an installer this big is reported by size only. */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_DOWNLOADS = 5;

/** The file, and the User-Agent of the visit that got it: a host may serve it only to that browser. */
export type DownloadedFile = { url: string; fileName: string; contentType?: string; bytes: Buffer; userAgent: string; observedAt: Date };

/** A download that started but could not be read: too large, or gone before its body arrived. */
export type FailedDownload = { url: string; reason: string };

type Header = { name: string; value: string };
type PausedResponse = { requestId: string; frameId?: string; request: { url: string }; responseStatusCode?: number; responseHeaders?: Header[] };

function header(headers: readonly Header[] | undefined, name: string): string | undefined {
	return headers?.find((candidate) => candidate.name.toLowerCase() === name)?.value;
}

/** The file name a download is saved as: the server's, else the browser's suggestion, else the URL's last segment. */
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

/** A response the browser saves rather than shows: an attachment, or a document that is not a page. */
export function isDownloadResponse(paused: Pick<PausedResponse, "responseStatusCode" | "responseHeaders">): boolean {
	if (/^\s*attachment/i.test(header(paused.responseHeaders, "content-disposition") ?? "")) return true;
	const status = paused.responseStatusCode ?? 0;
	if (status < 200 || status >= 300) return false;
	const type = header(paused.responseHeaders, "content-type") ?? "";
	return !/^\s*(?:text\/html|application\/xhtml\+xml|text\/plain|image\/[\w.+-]+|application\/pdf)?\s*(?:;|$)/i.test(type);
}

/** Read a blob: or data: file the page's script built, inside the page. */
async function readInPage(page: Page, url: string): Promise<{ bytes: Buffer; contentType?: string } | { tooLarge: number }> {
	const read = await page.evaluate(async (href, limit) => {
		const blob = await (await fetch(href)).blob();
		if (blob.size > limit) return { tooLarge: blob.size };
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let binary = "";
		for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
		return { base64: btoa(binary), type: blob.type };
	}, url, MAX_DOWNLOAD_BYTES);
	if ("tooLarge" in read) return { tooLarge: read.tooLarge! };
	return { bytes: Buffer.from(read.base64!, "base64"), ...(read.type ? { contentType: read.type } : {}) };
}

/**
 * A tab whose downloads are taken: its raw CDP session, its main frame's id
 * (the tab's target id), and its page once it has one (to read a file its
 * script built).
 */
export type DownloadTab = {
	targetId: string;
	session: CDPSession;
	page?: Page;
	/** Settings its first page must have applied before it is let through (a new tab's identity). */
	beforeFirstPage?: readonly Promise<unknown>[];
};

/** How long a first page waits for its tab's settings; a tab whose browser never answers still loads. */
const SETTINGS_WAIT_MS = 5_000;

export type DownloadInterceptor<Tab extends DownloadTab> = {
	/** Take the downloads of one more tab; the tab must not have run yet for none to slip past. */
	attach(tab: Tab): Promise<void>;
	files(): DownloadedFile[];
	failures(): FailedDownload[];
	/** Resolves once every download that has started is read or failed. */
	settled(): Promise<void>;
};

/**
 * Hold every document response of the visit's tabs at the network layer:
 * pages pass on, a download is read and aborted. Each tab's own CDP session
 * is used, so the agent driving it sees the download fail rather than
 * complete. `taken` hears of each tab that delivered a file, and whether
 * the tab's main frame had shown a page of its own before.
 */
export function interceptDownloads<Tab extends DownloadTab>(userAgent: string, taken: (tab: Tab, showedPage: boolean) => void = () => undefined): DownloadInterceptor<Tab> {
	const files: DownloadedFile[] = [];
	const failures: FailedDownload[] = [];
	const pending = new Set<Promise<unknown>>();
	const track = (work: Promise<unknown>) => {
		pending.add(work);
		void work.finally(() => pending.delete(work));
	};
	const full = () => files.length + failures.length >= MAX_DOWNLOADS;
	let denied = false;

	const attach = async (tab: Tab) => {
		const cdp = tab.session;
		let showedPage = false;
		cdp.on("Fetch.requestPaused", (paused: PausedResponse) => track((async () => {
			if (!isDownloadResponse(paused) || full()) {
				if (paused.frameId === tab.targetId && !showedPage) {
					showedPage = true;
					// The tab runs by now, so the settings it was given while held are answered.
					await Promise.race([Promise.all(tab.beforeFirstPage ?? []), new Promise((resolve) => setTimeout(resolve, SETTINGS_WAIT_MS))]);
				}
				await cdp.send("Fetch.continueRequest", { requestId: paused.requestId }).catch(() => undefined);
				return;
			}
			await takeResponse(cdp, paused);
			taken(tab, showedPage);
		})()));
		cdp.on("Page.downloadWillBegin", (event: { url: string; suggestedFilename: string }) => {
			if (!/^(?:blob|data):/i.test(event.url) || full()) return;
			track((async () => {
				const url = event.url.slice(0, 300);
				try {
					if (!tab.page) throw new Error("the tab that built the file has no page to read it from");
					const read = await readInPage(tab.page, event.url);
					if ("tooLarge" in read) failures.push({ url, reason: `the file is ${read.tooLarge} bytes, more than the ${MAX_DOWNLOAD_BYTES} bytes a visit reads` });
					else files.push({ url, fileName: downloadFileName(event.url, undefined, event.suggestedFilename), ...read, userAgent, observedAt: new Date() });
				} catch (error) {
					failures.push({ url, reason: error instanceof Error ? error.message : String(error) });
				}
			})());
		});
		// The tab may be held before it runs: it answers Page only once it does; Fetch is the browser's own.
		sendBeforeRun(cdp, "Page.enable");
		await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Response" }] });
		if (denied) return;
		denied = true;
		// A file built by script would otherwise be saved; nothing reaches the browser's disk.
		await cdp.send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: true }).catch(() => undefined);
	};

	const takeResponse = async (cdp: CDPSession, paused: PausedResponse) => {
		try {
			const length = Number(header(paused.responseHeaders, "content-length"));
			if (length > MAX_DOWNLOAD_BYTES) {
				failures.push({ url: paused.request.url, reason: `the file is ${length} bytes, more than the ${MAX_DOWNLOAD_BYTES} bytes a visit reads` });
			} else {
				const body = await cdp.send("Fetch.getResponseBody", { requestId: paused.requestId });
				const contentType = header(paused.responseHeaders, "content-type");
				files.push({
					url: paused.request.url,
					fileName: downloadFileName(paused.request.url, header(paused.responseHeaders, "content-disposition")),
					...(contentType ? { contentType } : {}),
					bytes: Buffer.from(body.body, body.base64Encoded ? "base64" : "utf8"),
					userAgent,
					observedAt: new Date(),
				});
			}
		} catch (error) {
			failures.push({ url: paused.request.url, reason: error instanceof Error ? error.message : String(error) });
		}
		// The browser never saves the file.
		await cdp.send("Fetch.failRequest", { requestId: paused.requestId, errorReason: "Aborted" }).catch(() => undefined);
	};

	return {
		attach,
		files: () => [...files],
		failures: () => [...failures],
		settled: async () => {
			while (pending.size) await Promise.allSettled([...pending]);
		},
	};
}
