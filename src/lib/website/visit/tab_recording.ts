
import type { ObservedHop, ObservedResponse } from "../../browser/tab_traffic";
import type { WebsiteKitResource, WebsiteNavigationHop } from "../types";
import { sha256Hex } from "../../util/hash";
import type { DocumentAnswer } from "./document_bodies";

/**
 * What a capture records of one tab while it is shown: each main-frame
 * document it passed through with the redirects that led there and the raw
 * body it was answered with, and the scripts and stylesheets it received.
 * Fed by puppeteer for the captured tab and by the raw CDP session of a tab
 * the site opened, through the same observed responses; the bodies come from
 * the Fetch domain (see `document_bodies`).
 */

/** One answer of a document's chain, with when it arrived when the network layer saw it. */
type RecordedHop = ObservedHop & { receivedAt?: string };

/** A main-frame document the tab showed: the redirects that led to it, then its own answer, with the body the network delivered. */
export type NavigationDocument = { url: string; hops: RecordedHop[]; body?: Buffer };

/** The raw body of one hop of a capture's navigation, by the hop's index there. */
export type HopBody = { hopIndex: number; body: Buffer };

/** The hops that led to a captured page, with the raw bodies of the document answers among them. */
export type CapturedChain = { hops: WebsiteNavigationHop[]; bodies: HopBody[] };

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
	/** Feed one answer the tab's main frame got, with its raw body when it is a page; it usually arrives before the response is observed. */
	recordAnswer(answer: DocumentAnswer): void;
	/** Give each hop of each document the answer recorded for it, also one that arrived after the document was observed. */
	settleAnswers(): void;
	kitResources(): Promise<WebsiteKitResource[]>;
};

export function recordTab(): TabRecording {
	const documents: NavigationDocument[] = [];
	const answers: DocumentAnswer[] = [];
	const kit = recordKitResources();
	/**
	 * Give each hop of the document not yet matched the oldest unclaimed answer of its address and status: a page loaded twice
	 * has two, in order. The network layer never sees a URL's fragment, which puppeteer's addresses keep (`#victim@mail.com`).
	 */
	const claimAnswers = (document: NavigationDocument) => {
		document.hops.forEach((hop, position) => {
			if (hop.receivedAt) return;
			const url = withoutFragment(hop.url);
			const index = answers.findIndex((answer) => withoutFragment(answer.url) === url && answer.status === hop.status);
			if (index < 0) return;
			const [answer] = answers.splice(index, 1);
			hop.receivedAt = answer!.receivedAt;
			// The document's own answer is its last hop; the redirects before it have no page.
			if (position === document.hops.length - 1 && answer!.body) document.body ??= answer!.body;
		});
	};
	return {
		documents,
		observe: (response) => {
			kit.observe(response);
			// An HTTP error document (a bot check that reloads into the real page) is replaced, not passed through.
			if (isDocumentAnswer(response) && response.status !== null && response.status >= 200 && response.status < 300) {
				const document = navigationDocument(response);
				claimAnswers(document);
				documents.push(document);
			}
		},
		recordAnswer: (answer) => {
			answers.push(answer);
		},
		settleAnswers: () => {
			for (const document of documents) claimAnswers(document);
		},
		kitResources: kit.settled,
	};
}

function withoutFragment(url: string): string {
	const hash = url.indexOf("#");
	return hash < 0 ? url : url.slice(0, hash);
}

/** A hop with the raw body of its answer, before the hops are numbered. */
type BodiedHop = { hop: WebsiteNavigationHop; body?: Buffer };

/** Number the hops in order and keep each body by its hop's number. */
function capturedChain(bodied: readonly BodiedHop[]): CapturedChain {
	return {
		hops: bodied.map(({ hop }, index) => ({ ...hop, index })),
		bodies: bodied.flatMap(({ body }, index) => (body ? [{ hopIndex: index, body }] : [])),
	};
}

/** The hops of one document: each redirect, then the document itself (with its body), marked as the captured content when it is. */
function navigationHops(document: NavigationDocument | null, finalUrl: string): BodiedHop[] {
	const answers = document?.hops ?? [];
	if (answers.length === 0) {
		const { hostname } = new URL(finalUrl);
		return [{ hop: { index: 0, url: finalUrl, hostname, status: null, contentCaptured: true } }];
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
			...(answer.receivedAt ? { receivedAt: answer.receivedAt } : {}),
			contentCaptured: false,
		};
	});

	// The document's own answer is the last one; the redirects before it have no body worth keeping.
	const answer = hops.at(-1)!;
	if (document?.body) answer.bodyCaptured = true;
	const matchingCapturedIndex = hops.findLastIndex((hop) => hop.url === finalUrl);
	if (matchingCapturedIndex >= 0) hops[matchingCapturedIndex]!.contentCaptured = true;
	else {
		const { hostname } = new URL(finalUrl);
		if (!answer.redirectTo) answer.redirectTo = finalUrl;
		hops.push({ index: hops.length, url: finalUrl, hostname, status: null, contentCaptured: true });
	}
	return hops.map((hop) => (hop === answer && document?.body ? { hop, body: document.body } : { hop }));
}

/**
 * Hops of every main-frame document the visit passed through, in order, with
 * the body of each. Each document but the last sent the visitor on by script,
 * so its last hop points at the next document's first request; only the last
 * document is captured.
 */
export function documentNavigationHops(documents: readonly NavigationDocument[], capturedDocumentUrl: string): CapturedChain {
	if (documents.length === 0) return capturedChain(navigationHops(null, capturedDocumentUrl));
	return capturedChain(documents.flatMap((document, position) => {
		const next = documents[position + 1];
		if (!next) return navigationHops(document, capturedDocumentUrl);
		const hops = navigationHops(document, document.url).map(({ hop, body }) => ({ hop: { ...hop, contentCaptured: false }, ...(body ? { body } : {}) }));
		const last = hops.at(-1)?.hop;
		if (last && !last.redirectTo) last.redirectTo = next.hops[0]?.url ?? next.url;
		return hops;
	}));
}

/**
 * Hops of what a page action opened: the documents that arrived after it (a
 * POST answered by a redirect, then the next page), or the same document again
 * when the kit swapped in its next step without navigating; its body belongs
 * to the step that first showed it.
 */
export function actionResultHops(arrived: readonly NavigationDocument[], current: NavigationDocument | undefined, capturedDocumentUrl: string): CapturedChain {
	if (arrived.length) return documentNavigationHops(arrived, capturedDocumentUrl);
	const { redirectTo: _redirectTo, bodyCaptured: _bodyCaptured, receivedAt: _receivedAt, ...hop } = navigationHops(current ?? null, capturedDocumentUrl).at(-1)!.hop;
	return { hops: [{ ...hop, index: 0, contentCaptured: true }], bodies: [] };
}
