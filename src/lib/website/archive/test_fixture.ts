import { type Browser, type BrowserContext, type HTTPRequest, type HTTPResponse } from "rebrowser-puppeteer-core";
import sharp from "sharp";

import type { FabricEgress } from "../../browser/fabric";

/**
 * A fake browser for live-capture tests: it answers navigations with scripted
 * responses, holds document responses in an emulated Fetch domain, and counts
 * what the capture asked of it. Shared by the archive's test files.
 */

// The fake document draws no frames, hidden or not.
export const mainFrame = { childFrames: () => [] };
/** The captured tab's target, whose id its main frame shares. */
export const TARGET_ID = "captured-tab";
/** Live captures in tests wait only briefly for a page's own script navigation. */
export const fast = { scriptNavigationSettleMs: 20 } as const;

export function responseForNavigation(
	url: string,
	status: number,
	options: { location?: string; contentType?: string; redirects?: Array<{ url: string; status: number; location?: string }> } = {},
): HTTPResponse {
	const response = (hopUrl: string, hopStatus: number, headers: Record<string, string>, redirects: HTTPRequest[]): HTTPResponse => {
		let hopResponse: HTTPResponse;
		const request = {
			url: () => hopUrl,
			response: () => hopResponse,
			redirectChain: () => redirects,
			isNavigationRequest: () => true,
			resourceType: () => "document",
			frame: () => mainFrame,
		} as unknown as HTTPRequest;
		hopResponse = {
			ok: () => hopStatus >= 200 && hopStatus < 300,
			status: () => hopStatus,
			url: () => hopUrl,
			headers: () => headers,
			request: () => request,
		} as HTTPResponse;
		return hopResponse;
	};
	const redirects = options.redirects ?? [];
	const priorRequests: HTTPRequest[] = [];
	for (const redirect of redirects) {
		const redirectResponse = response(redirect.url, redirect.status, {
			...(redirect.location ? { location: redirect.location } : {}),
			"content-type": "text/html",
		}, priorRequests.slice());
		const redirectRequest = {
			url: () => redirect.url,
			response: () => redirectResponse,
			redirectChain: () => priorRequests.slice(),
		} as unknown as HTTPRequest;
		priorRequests.push(redirectRequest);
	}
	return response(url, status, {
		...(options.location ? { location: options.location } : {}),
		...(options.contentType ? { "content-type": options.contentType } : {}),
	}, priorRequests) as HTTPResponse;
}

export type FixtureNavigation = {
	url: string;
	egress: FabricEgress;
	/** Deliver a later main-frame document response, as a self-replacing interstitial does. */
	replaceDocument: (response: HTTPResponse) => void;
	/** Deliver a subresource response (script, stylesheet, image) the page loaded. */
	loadResource: (response: HTTPResponse) => void;
};

/** A non-navigation subresource response with a body. */
export function subresource(url: string, resourceType: string, body: string | Error, options: { status?: number; contentType?: string } = {}): HTTPResponse {
	const request = {
		url: () => url,
		isNavigationRequest: () => false,
		resourceType: () => resourceType,
		frame: () => mainFrame,
		redirectChain: () => [],
	} as unknown as HTTPRequest;
	return {
		ok: () => (options.status ?? 200) < 300,
		status: () => options.status ?? 200,
		url: () => url,
		headers: () => (options.contentType ? { "content-type": options.contentType } : {}),
		request: () => request,
		buffer: async () => {
			if (body instanceof Error) throw body;
			return Buffer.from(body);
		},
	} as unknown as HTTPResponse;
}

/** A page with something drawn on it, and one Chromium had not painted yet. */
export const PAINTED_PNG = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#ffffff" } })
	.composite([{ input: { create: { width: 32, height: 12, channels: 3, background: "#202124" } }, top: 18, left: 16 }])
	.png().toBuffer();
export const BLANK_PNG = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#ffffff" } }).png().toBuffer();

export function archiveBrowserFixture(options: {
	goto?: (navigation: FixtureNavigation) => Promise<HTTPResponse | null>;
	/** How the page's network goes idle; may render the document's body meanwhile. */
	networkIdle?: (wait: { timeout?: number; render: (body: string) => void }) => Promise<void>;
	pageUrl?: string;
	/** Screenshots served in order; the last repeats. Defaults to a painted page. */
	/** What each screenshot answers: an image, an error it throws, or "hang" for one that never answers. */
	screenshots?: Array<Buffer | Error | "hang">;
	/**
	 * Hold every document response in the Fetch domain, as Chromium does for the capture's own session,
	 * answering each address named here with that raw body; one not named has an empty body. A body is
	 * read as a stream in small pieces, and the emulated domain fails a command Chromium would not honour.
	 */
	documentBodies?: Record<string, string>;
} = {}) {
	const eventNames: string[] = [];
	/** Every CDP command of the tab's own sessions, in order. */
	const cdpCommands: Array<{ method: string; params?: unknown }> = [];
	const navigationCalls: Array<{ url: string; egress: FabricEgress; waitUntil?: string; timeout?: number; referer?: string }> = [];
	const networkIdleWaits: Array<{ idleTime?: number; concurrency?: number; timeout?: number }> = [];
	const leasedEgress: FabricEgress[] = [];
	let interceptionEnabled = false;
	let screenshotCount = 0;
	/** Whether each screenshot asked for the whole page or only the viewport, in order. */
	const screenshotFullPage: boolean[] = [];
	let closeCount = 0;
	let captureSnapshotCount = 0;
	/** Every response the emulated Fetch domain held, by request id; and the streams of the bodies taken, by handle. */
	const held = new Map<string, { body: Buffer; taken?: string; released?: "continued" | "fulfilled" | "failed" }>();
	const streams = new Map<string, { requestId: string; position: number; closed: boolean }>();

	const getBrowser = async (egress: FabricEgress = "phishing") => {
		leasedEgress.push(egress);
		const responseListeners: Array<(response: HTTPResponse) => void> = [];
		let currentUrl = options.pageUrl ?? "https://example.test/";
		let body = "Captured page text";
		// The Fetch domain of the tab: a session that enabled it holds every document response until it lets it go on.
		const holding = new Set<(paused: unknown) => void>();
		const holdDocument = (response: HTTPResponse) => {
			if (!options.documentBodies) return;
			for (const document of [...response.request().redirectChain().map((request) => request.response()!), response]) {
				const requestId = `request-${held.size + 1}`;
				held.set(requestId, { body: Buffer.from(options.documentBodies?.[document.url()] ?? "") });
				const headers = Object.entries(document.headers()).map(([name, value]) => ({ name, value }));
				for (const listener of holding) listener({ requestId, frameId: TARGET_ID, request: { url: document.url() }, responseStatusCode: document.status(), responseHeaders: headers });
			}
		};
		const context = {} as BrowserContext;
		const page = {
			browser: () => browser,
			browserContext: () => context,
			mainFrame: () => mainFrame,
			// The fake document draws no frame a verification gate could sit in.
			frames: () => [],
			createCDPSession: async () => ({ send: async (method: string) => (method === "Browser.getWindowForTarget" ? { windowId: 1 } : {}) }),
			on: (event: string, listener: (response: HTTPResponse) => void) => {
				eventNames.push(event);
				if (event === "response") responseListeners.push(listener);
			},
			setRequestInterception: async (enabled: boolean) => { interceptionEnabled = enabled; },
			setUserAgent: async () => undefined,
			evaluateOnNewDocument: async () => ({ identifier: "1" }),
			goto: async (url: string, navigation: { waitUntil?: string; timeout?: number; referer?: string }) => {
				navigationCalls.push({ url, egress, ...navigation });
				const deliver = (response: HTTPResponse) => {
					holdDocument(response);
					currentUrl = response.url();
					for (const listener of responseListeners) listener(response);
				};
				const loadResource = (response: HTTPResponse) => {
					for (const listener of responseListeners) listener(response);
				};
				const response = options.goto
					? await options.goto({ url, egress, replaceDocument: deliver, loadResource })
					: responseForNavigation(options.pageUrl ?? url, 200, { contentType: "text/html" });
				if (response) deliver(response);
				return response;
			},
			waitForNetworkIdle: async (wait: { idleTime?: number; concurrency?: number; timeout?: number }) => {
				networkIdleWaits.push(wait);
				await options.networkIdle?.({ timeout: wait.timeout, render: (html) => { body = html; } });
			},
			screenshot: async (screenshotOptions?: { fullPage?: boolean }) => {
				screenshotFullPage.push(screenshotOptions?.fullPage === true);
				const shots = options.screenshots ?? [PAINTED_PNG];
				const shot = shots[Math.min(screenshotCount++, shots.length - 1)]!;
				if (shot === "hang") return new Promise<Buffer>(() => undefined);
				if (shot instanceof Error) throw shot;
				return shot;
			},
			target: () => ({
				_targetId: TARGET_ID,
				createCDPSession: async () => {
					let onPaused: ((paused: unknown) => void) | undefined;
					return {
					on: (event: string, listener: (paused: unknown) => void) => {
						if (event !== "Fetch.requestPaused") throw new Error(`Unexpected CDP event ${event}`);
						onPaused = listener;
					},
					off: () => { onPaused = undefined; },
					send: async (method: string, params?: { requestId?: string }) => {
						cdpCommands.push({ method, ...(params ? { params } : {}) });
						if (method === "Emulation.setUserAgentOverride") return {};
						if (method === "Fetch.enable") { if (onPaused) holding.add(onPaused); return {}; }
						if (method === "Fetch.disable") { for (const listener of holding) if (listener === onPaused) holding.delete(listener); return {}; }
						if (method.startsWith("Fetch.") || method.startsWith("IO.")) return emulateFetch(method, params as FetchParams);
						if (method !== "Page.captureSnapshot") throw new Error(`Unexpected CDP command ${method}`);
						captureSnapshotCount++;
						return {
							data: [
								"From: <Saved by Blink>",
								`Snapshot-Content-Location: ${currentUrl}`,
								"Content-Type: multipart/related; boundary=\"archive-test\"",
								"",
								"--archive-test",
								"Content-Type: text/html",
								`Content-Location: ${currentUrl}`,
								"",
								`<html><head><title>Captured title</title></head><body>${body}</body></html>`,
								"--archive-test--",
							].join("\r\n"),
						};
					},
					detach: async () => undefined,
					};
				},
			}),
			evaluate: async (callback: () => unknown) => {
				const source = callback.toString();
				if (source.includes("readyState")) return "interactive";
				// The blank-screenshot retry asks whether the page shows text, then waits for a frame.
				if (source.includes("innerText")) return body.trim().length > 0;
				if (source.includes("requestAnimationFrame")) return undefined;
				throw new Error("Unexpected page evaluation");
			},
			title: async () => "Just a moment...",
			url: () => currentUrl,
		};
		const browser = {
			defaultBrowserContext: () => ({ ...context, pages: async () => [], newPage: async () => page }),
			version: async () => "Chrome/156.0.8078.73",
			close: async () => { closeCount++; },
		} as unknown as Browser;
		return browser;
	};

	type FetchParams = { requestId?: string; handle?: string; size?: number };
	/** The Fetch and IO commands on held responses, as Chromium answers them. */
	const emulateFetch = (method: string, params: FetchParams) => {
		const response = params.requestId ? held.get(params.requestId) : undefined;
		const stream = params.handle ? streams.get(params.handle) : undefined;
		if (method === "Fetch.takeResponseBodyAsStream") {
			if (!response || response.released || response.taken) throw new Error(`Invalid state for ${method}`);
			response.taken = `stream-${params.requestId}`;
			streams.set(response.taken, { requestId: params.requestId!, position: 0, closed: false });
			return { stream: response.taken };
		}
		if (method === "IO.read") {
			if (!stream || stream.closed) throw new Error("Invalid stream handle");
			const body = held.get(stream.requestId)!.body;
			// Small pieces, so a page arrives over several reads.
			const piece = body.subarray(stream.position, stream.position + Math.min(params.size ?? 64, 16));
			stream.position += piece.byteLength;
			// Text where the piece is valid UTF-8, else base64, as Chromium sends it.
			const text = piece.toString("utf8");
			const eof = stream.position >= body.byteLength;
			return Buffer.from(text).equals(piece) ? { data: text, base64Encoded: false, eof } : { data: piece.toString("base64"), base64Encoded: true, eof };
		}
		if (method === "IO.close") {
			if (!stream || stream.closed) throw new Error("Invalid stream handle");
			stream.closed = true;
			return {};
		}
		if (!response || response.released) throw new Error(`Invalid InterceptionId for ${method}`);
		// A response whose body was taken can only be answered or failed.
		if (method === "Fetch.continueRequest" && !response.taken) response.released = "continued";
		else if (method === "Fetch.fulfillRequest") response.released = "fulfilled";
		else if (method === "Fetch.failRequest") response.released = "failed";
		else throw new Error(`Unexpected ${method} on a held response`);
		return {};
	};

	return {
		getBrowser,
		eventNames,
		cdpCommands,
		/** How each held response went on, in the order they were held, and whether any taken body's stream was left open. */
		heldResponses: () => [...held.values()].map(({ released }) => released),
		get openStreams() { return [...streams.values()].filter(({ closed }) => !closed).length; },
		navigationCalls,
		networkIdleWaits,
		leasedEgress,
		get interceptionEnabled() { return interceptionEnabled; },
		get screenshotCount() { return screenshotCount; },
		screenshotFullPage,
		get closeCount() { return closeCount; },
		get captureSnapshotCount() { return captureSnapshotCount; },
	};
}
