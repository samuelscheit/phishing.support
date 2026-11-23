import type { CDPSession, Protocol } from "rebrowser-puppeteer-core";

import { raceTimeout } from "../../util/async";
import { isDownloadResponse } from "./download";

/**
 * The raw body of every main-frame document a tab is answered with, read at
 * the network layer before the browser gets it. Chromium drops the body of a
 * document the tab already left (an interstitial whose script navigates on
 * at once lives in a renderer that is gone by then), so neither puppeteer nor
 * `Network.getResponseBody` can read it afterwards. Holding the response in
 * the Fetch domain can: the body is read, then the response goes on unchanged.
 * Several sessions may hold the same tab's responses; each lets them go on.
 */

/**
 * A document answer of the tab's main frame: when it arrived, and the raw
 * body of a page (a redirect has none worth keeping).
 */
export type DocumentAnswer = { url: string; status: number; receivedAt: string; body?: Buffer };

type Header = { name: string; value: string };
/** A response held in the Fetch domain's response stage. */
export type PausedDocument = { requestId: string; frameId?: string; request: { url: string }; responseStatusCode?: number; responseHeaders?: Header[] };

/** A document body larger than this is a file, not a page of the chain. */
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
/** How long a body may take to arrive before the response is let go without it. */
const BODY_TIMEOUT_MS = 15_000;

/**
 * A held response of the tab's main frame, stamped with when it arrived,
 * with its body when it is a page the tab shows: a 2xx answer that is not a
 * download. Undefined for another frame's documents; the caller always lets
 * the response go on.
 */
export async function readDocumentAnswer(session: CDPSession, paused: PausedDocument, mainFrameId: string): Promise<DocumentAnswer | undefined> {
	if (paused.frameId !== mainFrameId) return undefined;
	const status = paused.responseStatusCode ?? 0;
	const answer = { url: paused.request.url, status, receivedAt: new Date().toISOString() };
	if (status < 200 || status >= 300 || isDownloadResponse(paused)) return answer;
	const body = await readBody(session, paused);
	return body ? { ...answer, body } : answer;
}

async function readBody(session: CDPSession, paused: PausedDocument): Promise<Buffer | undefined> {
	const length = Number(paused.responseHeaders?.find((header) => header.name.toLowerCase() === "content-length")?.value);
	if (length > MAX_DOCUMENT_BYTES) return undefined;
	try {
		const read = await raceTimeout(session.send("Fetch.getResponseBody", { requestId: paused.requestId }), BODY_TIMEOUT_MS, () => new Error("the document body never arrived"));
		const body = Buffer.from(read.body, read.base64Encoded ? "base64" : "utf8");
		// An empty answer is no page to keep.
		return body.byteLength > 0 && body.byteLength <= MAX_DOCUMENT_BYTES ? body : undefined;
	} catch (error) {
		console.warn(`The body of ${paused.request.url.slice(0, 200)} could not be read: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

/**
 * Hold every document response of a tab on a session of its own, record
 * each answer of its main frame (a redirect's too) with the body of each
 * page, and let every response go on. Returns the function that stops
 * holding them. Chromium
 * takes the navigator.platform of a navigation it holds from the holding
 * session, so that session presents the tab's identity too (`identity`);
 * without it an iPhone capture's page reads the host's platform.
 */
export async function interceptDocumentAnswers(session: CDPSession, mainFrameId: string, record: (answer: DocumentAnswer) => void, identity: Protocol.Emulation.SetUserAgentOverrideRequest): Promise<() => Promise<void>> {
	await session.send("Emulation.setUserAgentOverride", identity);
	const onPaused = (paused: PausedDocument) => {
		void (async () => {
			const answer = await readDocumentAnswer(session, paused, mainFrameId);
			if (answer) record(answer);
			await session.send("Fetch.continueRequest", { requestId: paused.requestId }).catch(() => undefined);
		})();
	};
	session.on("Fetch.requestPaused", onPaused);
	await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Response" }] });
	return async () => {
		session.off("Fetch.requestPaused", onPaused);
		await session.send("Fetch.disable").catch(() => undefined);
		await session.detach().catch(() => undefined);
	};
}
