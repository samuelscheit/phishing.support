
import type { ObservedHop, ObservedResponse } from "../browser/tab_traffic";
import type { WebsiteKitResource, WebsiteNavigationHop } from "./types";
import { sha256Hex } from "../util/hash";

/**
 * What a capture records of one tab while it is shown: each main-frame
 * document it passed through with the redirects that led there, and the
 * scripts and stylesheets it received. Fed by puppeteer for the captured tab
 * and by the raw CDP session of a tab the site opened, through the same
 * observed responses.
 */

/** A main-frame document the tab showed: the redirects that led to it, then its own answer. */
export type NavigationDocument = { url: string; hops: ObservedHop[] };

const KIT_RESOURCE_TYPES = new Set(["script", "stylesheet"]);
const MAX_KIT_RESOURCES = 40;
const MAX_KIT_RESOURCE_BYTES = 2 * 1024 * 1024;

/** An http(s) document; a blob: or chrome-error:// document belongs to no request chain. */
export function isNetworkDocument(url: string): boolean {
	return /^https?:/i.test(url);
}

/** A final answer to a main-frame navigation: no redirect, and from the network. */
export function isDocumentAnswer(response: Pick<ObservedResponse, "mainFrameNavigation" | "status" | "url">): boolean {
	const status = response.status ?? 0;
	return response.mainFrameNavigation && (status < 300 || status >= 400) && isNetworkDocument(response.url);
}

function navigationDocument(response: ObservedResponse): NavigationDocument {
	return { url: response.url, hops: [...response.redirects, { url: response.url, status: response.status, headers: response.headers }] };
}

/**
 * Record the hash of every script and stylesheet response body, from any
 * host, exactly as received. These are the bytes urlscan.io hashes; the MHTML
 * snapshot cannot provide them because it omits scripts and rewrites CSS.
 * A loader kit serves its real code from a separate backend host, so those
 * files are kept too; sibling discovery judges each one by its rarity.
 */
function recordKitResources(): { observe: (response: ObservedResponse) => void; settled: () => Promise<WebsiteKitResource[]> } {
	const pending: Array<Promise<WebsiteKitResource | undefined>> = [];
	return {
		observe: (response) => {
			if (pending.length >= MAX_KIT_RESOURCES || !KIT_RESOURCE_TYPES.has(response.resourceType) || response.status !== 200) return;
			pending.push((async () => {
				const body = await response.body();
				if (body.byteLength === 0 || body.byteLength > MAX_KIT_RESOURCE_BYTES) return undefined;
				return {
					url: response.url,
					mimeType: (response.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase() || response.resourceType,
					size: body.byteLength,
					sha256: sha256Hex(body),
				};
			})().catch(() => undefined));
		},
		// Once per hash: the same file under a second URL identifies nothing new.
		settled: async () => (await Promise.all(pending)).filter((resource, index, all): resource is WebsiteKitResource =>
			Boolean(resource) && all.findIndex((other) => other?.sha256 === resource!.sha256) === index),
	};
}

export type TabRecording = {
	/** Every successful main-frame document the tab passed through, in order. */
	documents: NavigationDocument[];
	/** Feed one response the tab received. */
	observe(response: ObservedResponse): void;
	kitResources(): Promise<WebsiteKitResource[]>;
};

export function recordTab(): TabRecording {
	const documents: NavigationDocument[] = [];
	const kit = recordKitResources();
	return {
		documents,
		observe: (response) => {
			kit.observe(response);
			// An HTTP error document (a bot check that reloads into the real page) is replaced, not passed through.
			if (isDocumentAnswer(response) && response.status !== null && response.status >= 200 && response.status < 300) documents.push(navigationDocument(response));
		},
		kitResources: kit.settled,
	};
}

/** The hops of one document: each redirect, then the document itself, marked as the captured content when it is. */
function navigationHops(document: NavigationDocument | null, finalUrl: string): WebsiteNavigationHop[] {
	const answers = document?.hops ?? [];
	if (answers.length === 0) {
		const { hostname } = new URL(finalUrl);
		return [{ index: 0, url: finalUrl, hostname, status: null, contentCaptured: true }];
	}

	const hops = answers.map((answer, index): WebsiteNavigationHop => {
		const { hostname } = new URL(answer.url);
		const location = answer.status !== null && answer.status >= 300 && answer.status < 400 ? answer.headers.location : undefined;
		let redirectTo: string | undefined;
		if (location) {
			try {
				redirectTo = new URL(location, answer.url).toString();
			} catch {
				// Keep malformed redirect destinations out of the navigation record.
			}
		}
		return {
			index,
			url: answer.url,
			hostname,
			status: answer.status,
			...(redirectTo ? { redirectTo } : {}),
			...(answer.headers["content-type"] ? { contentType: answer.headers["content-type"] } : {}),
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
 * Hops of every main-frame document the visit passed through, in order. Each
 * document but the last sent the visitor on by script, so its last hop points
 * at the next document's first request; only the last document is captured.
 */
export function documentNavigationHops(documents: readonly NavigationDocument[], capturedDocumentUrl: string): WebsiteNavigationHop[] {
	if (documents.length === 0) return navigationHops(null, capturedDocumentUrl);
	return documents.flatMap((document, position) => {
		const next = documents[position + 1];
		if (!next) return navigationHops(document, capturedDocumentUrl);
		const hops = navigationHops(document, document.url).map((hop) => ({ ...hop, contentCaptured: false }));
		const last = hops.at(-1);
		if (last && !last.redirectTo) last.redirectTo = next.hops[0]?.url ?? next.url;
		return hops;
	}).map((hop, index) => ({ ...hop, index }));
}

/**
 * Hops of what a page action opened: the documents that arrived after it (a
 * POST answered by a redirect, then the next page), or the same document again
 * when the kit swapped in its next step without navigating.
 */
export function actionResultHops(arrived: readonly NavigationDocument[], current: NavigationDocument | undefined, capturedDocumentUrl: string): WebsiteNavigationHop[] {
	if (arrived.length) return documentNavigationHops(arrived, capturedDocumentUrl);
	const { redirectTo: _, ...hop } = navigationHops(current ?? null, capturedDocumentUrl).at(-1)!;
	return [{ ...hop, index: 0, contentCaptured: true }];
}
