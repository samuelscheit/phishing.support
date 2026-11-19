import type { CDPSession, HTTPResponse, Page } from "rebrowser-puppeteer-core";

/** One answer of a request chain: a redirect, or the final response. */
export type ObservedHop = { url: string; status: number | null; headers: Record<string, string> };

/**
 * A response a tab received, the same whether puppeteer reported it or the
 * tab's raw CDP session did. A tab the site opens (target=_blank,
 * window.open) is only seen raw on its first load: puppeteer makes its page
 * once that load is already under way.
 */
export type ObservedResponse = ObservedHop & {
	/** Puppeteer's lowercase resource type: "document", "script", "stylesheet", … */
	resourceType: string;
	/** A navigation of the tab's main frame. */
	mainFrameNavigation: boolean;
	/** The redirects that led to this response, oldest first. */
	redirects: ObservedHop[];
	/** The body once it has arrived; rejects when it never does. */
	body(): Promise<Buffer>;
};

export type ResponseObserver = (response: ObservedResponse) => void;

function lowercaseHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
	return Object.fromEntries(Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
}

/** The response as puppeteer reported it on the tab's page. */
export function observedPuppeteerResponse(page: Page, response: HTTPResponse): ObservedResponse {
	const request = response.request();
	return {
		url: response.url(),
		status: response.status(),
		headers: response.headers(),
		resourceType: request.resourceType(),
		mainFrameNavigation: request.isNavigationRequest() && request.frame() === page.mainFrame(),
		redirects: request.redirectChain().map((hop) => {
			const answer = hop.response();
			return { url: hop.url(), status: answer?.status() ?? null, headers: answer?.headers() ?? {} };
		}),
		body: () => response.buffer(),
	};
}

/** Observe every response of the page through puppeteer. */
export function observePageResponses(page: Page, observe: ResponseObserver): void {
	page.on("response", (response) => observe(observedPuppeteerResponse(page, response)));
}

type CdpResponse = { url: string; status: number; headers?: Record<string, unknown> };

/** How long a body is waited for: a snapshot reading kit resources must not hang on one. */
const BODY_TIMEOUT_MS = 15_000;

/**
 * Observe every response of a tab on its raw CDP session, which must have
 * the Network domain enabled. The tab's main frame has the tab's target id.
 */
export function observeSessionResponses(session: CDPSession, mainFrameId: string, observe: ResponseObserver): void {
	type Pending = { redirects: ObservedHop[]; loaded: PromiseWithResolvers<void> };
	const requests = new Map<string, Pending>();
	const pending = (requestId: string): Pending => {
		let request = requests.get(requestId);
		if (!request) {
			const loaded = Promise.withResolvers<void>();
			// A body nobody asks for must not surface as an unhandled rejection.
			loaded.promise.catch(() => undefined);
			requests.set(requestId, request = { redirects: [], loaded });
		}
		return request;
	};
	const hop = (response: CdpResponse): ObservedHop => ({ url: response.url, status: response.status, headers: lowercaseHeaders(response.headers) });
	session.on("Network.requestWillBeSent", (event: { requestId: string; redirectResponse?: CdpResponse }) => {
		const request = pending(event.requestId);
		// A redirect reuses the request id: the earlier request got this answer.
		if (event.redirectResponse) request.redirects.push(hop(event.redirectResponse));
	});
	session.on("Network.responseReceived", (event: { requestId: string; type?: string; frameId?: string; response: CdpResponse }) => {
		const request = pending(event.requestId);
		const type = (event.type ?? "other").toLowerCase();
		observe({
			...hop(event.response),
			resourceType: type,
			mainFrameNavigation: type === "document" && event.frameId === mainFrameId,
			redirects: [...request.redirects],
			body: async () => {
				// A load cut off by a detached session or a closed tab never reports its end.
				let timer: ReturnType<typeof setTimeout> | undefined;
				const cutOff = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("the response never finished loading")), BODY_TIMEOUT_MS); });
				try {
					await Promise.race([request.loaded.promise, cutOff]);
				} finally {
					clearTimeout(timer);
				}
				const { body, base64Encoded } = await session.send("Network.getResponseBody", { requestId: event.requestId });
				return Buffer.from(body, base64Encoded ? "base64" : "utf8");
			},
		});
	});
	session.on("Network.loadingFinished", (event: { requestId: string }) => {
		requests.get(event.requestId)?.loaded.resolve();
		requests.delete(event.requestId);
	});
	session.on("Network.loadingFailed", (event: { requestId: string; errorText?: string }) => {
		requests.get(event.requestId)?.loaded.reject(new Error(event.errorText ?? "loading failed"));
		requests.delete(event.requestId);
	});
}
