import type { CDPSession, Protocol } from "rebrowser-puppeteer-core";

import { isDownloadResponse } from "./download";
import { takeHeldBody, type BodyLimits, type HeldBody } from "./held_body";

/**
 * The raw body of every main-frame document a tab is answered with, read at
 * the network layer before the browser gets it. Chromium drops the body of a
 * document the tab already left (an interstitial whose script navigates on
 * at once lives in a renderer that is gone by then), so neither puppeteer nor
 * `Network.getResponseBody` can read it afterwards. Holding the response in
 * the Fetch domain can: the body is taken as it streams in (see `held_body`)
 * and the page is answered with exactly the bytes read. Several sessions may
 * hold the same tab's responses; each lets them go on.
 */

/**
 * A document answer of the tab's main frame: when it arrived, and the raw
 * body of a page (a redirect has none worth keeping).
 */
export type DocumentAnswer = { url: string; status: number; receivedAt: string; body?: Buffer };

type Header = { name: string; value: string };
/** A response held in the Fetch domain's response stage. */
export type PausedDocument = { requestId: string; frameId?: string; request: { url: string }; responseStatusCode?: number; responseStatusText?: string; responseHeaders?: Header[] };

/**
 * How much of a page is read, and for how long. A body larger than this is a
 * file, not a page of the chain; one still arriving after this long is a
 * tarpit, or a server too slow to be a page anyone reads.
 */
export const DOCUMENT_BODY_LIMITS: BodyLimits = { maxBytes: 5 * 1024 * 1024, timeoutMs: 15_000 };

/** Headers that describe the body as it came over the wire, not the decoded and whole body the page is answered with. */
const WIRE_HEADERS = new Set(["content-length", "content-encoding", "transfer-encoding"]);

/** Whether an answer of this status carries a page: neither informational, a redirect, nor one without a body (204, 205). */
function carriesPage(status: number): boolean {
	return status >= 200 && status !== 204 && status !== 205 && (status < 300 || status >= 400);
}

/**
 * Let a held document response go on, and first record the answer of the
 * tab's main frame: when it arrived, with its body when it is a page the tab
 * shows (any answer with a body that is no redirect and no download: a kit's
 * page may answer 403, 404 or 500). Another frame's documents, a redirect, an
 * answer without a body, a download, and a page that declares itself larger
 * than the cap go on untouched, unread.
 *
 * A page's body is taken from the browser, so the page is answered with the
 * bytes read, with the status and headers it came with (cookies were stored
 * by the network layer before the response was held). A page within the
 * limits shows exactly what it would have. One that runs past the cap or the
 * time bound (a tarpit streaming HTML forever, or a page not declaring its
 * size) shows what arrived until then and keeps no body for the case: the
 * capture goes on with the page as it stood, never waits on the rest, and
 * never holds more of it than the cap. Failing the response instead would
 * leave the capture an error page, and the browser renders a never-ending
 * page's beginning as it streams in anyway. The cost is a large page served
 * without its size, or a page slower than the bound, cut off where it stood.
 *
 * A page the browser gets from DevTools has no remote address: Chromium puts
 * its document in the unknown, public-like address space, and Local Network
 * Access then blocks its loopback and private-network frames and requests.
 * Left to the network, a page behind the egress proxy would take the proxy's
 * own (private) address space, which no visitor's browser gives an internet
 * page; answered from DevTools it is public-like, as for a visitor. Only a
 * page served from a local address itself (a test's loopback server) loses
 * its frames there. Its TLS details and navigation timing are DevTools'
 * too, and nothing here reads them.
 */
export async function passDocument(session: CDPSession, paused: PausedDocument, mainFrameId: string, record: (answer: DocumentAnswer) => void, limits: BodyLimits = DOCUMENT_BODY_LIMITS): Promise<void> {
	const goOn = () => session.send("Fetch.continueRequest", { requestId: paused.requestId }).catch(() => undefined);
	if (paused.frameId !== mainFrameId) {
		await goOn();
		return;
	}
	const status = paused.responseStatusCode ?? 0;
	const answer: DocumentAnswer = { url: paused.request.url, status, receivedAt: new Date().toISOString() };
	const declared = Number(paused.responseHeaders?.find((header) => header.name.toLowerCase() === "content-length")?.value);
	if (!carriesPage(status) || isDownloadResponse(paused) || declared > limits.maxBytes) {
		record(answer);
		await goOn();
		return;
	}
	let held: HeldBody;
	try {
		held = await takeHeldBody(session, paused.requestId, limits);
	} catch (error) {
		console.warn(`The body of ${paused.request.url.slice(0, 200)} could not be taken: ${error instanceof Error ? error.message : String(error)}`);
		record(answer);
		await goOn();
		return;
	}
	if (!held.complete) console.warn(`The body of ${paused.request.url.slice(0, 200)} is not kept: ${held.reason}`);
	// An empty answer is no page to keep. Recorded before the page gets it, so the answer is there when the tab shows the page.
	record(held.complete && held.bytes.byteLength > 0 ? { ...answer, body: held.bytes } : answer);
	await session.send("Fetch.fulfillRequest", {
		requestId: paused.requestId,
		responseCode: status,
		...(paused.responseStatusText ? { responsePhrase: paused.responseStatusText } : {}),
		responseHeaders: (paused.responseHeaders ?? []).filter((header) => !WIRE_HEADERS.has(header.name.toLowerCase())),
		body: held.bytes.toString("base64"),
	}).catch(() => undefined);
}

/**
 * Hold every document response of a tab on a session of its own, record
 * each answer of its main frame (a redirect's too) with the body of each
 * page, and let every response go on. Returns the function that stops
 * holding them, once every body being read is read. Chromium
 * takes the navigator.platform of a navigation it holds from the holding
 * session, so that session presents the tab's identity too (`identity`);
 * without it an iPhone capture's page reads the host's platform.
 */
export async function interceptDocumentAnswers(session: CDPSession, mainFrameId: string, record: (answer: DocumentAnswer) => void, identity: Protocol.Emulation.SetUserAgentOverrideRequest, limits: BodyLimits = DOCUMENT_BODY_LIMITS): Promise<() => Promise<void>> {
	await session.send("Emulation.setUserAgentOverride", identity);
	const passing = new Set<Promise<void>>();
	const onPaused = (paused: PausedDocument) => {
		const passed = passDocument(session, paused, mainFrameId, record, limits);
		passing.add(passed);
		void passed.finally(() => passing.delete(passed));
	};
	session.on("Fetch.requestPaused", onPaused);
	await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Response" }] });
	return async () => {
		session.off("Fetch.requestPaused", onPaused);
		// A response whose body is taken is answered first; the Fetch domain must not let go of it half read. The time bound ends the wait.
		await Promise.allSettled([...passing]);
		await session.send("Fetch.disable").catch(() => undefined);
		await session.detach().catch(() => undefined);
	};
}
