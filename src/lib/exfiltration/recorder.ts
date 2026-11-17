import type { Browser, CDPSession, Target } from "rebrowser-puppeteer-core";

import type { CapturedNetworkRequest } from "./types";

const MAX_CAPTURE_COUNT = 2_000;
const MAX_VALUE_BYTES = 256 * 1024;
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;

function bounded(value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	return Buffer.byteLength(value) <= MAX_VALUE_BYTES
		? value
		: Buffer.from(value).subarray(0, MAX_VALUE_BYTES).toString("utf8");
}

/** CDP target types that own a network stack the kit can send from. */
const NETWORK_TARGET_TYPES = new Set(["page", "iframe", "worker", "service_worker", "shared_worker"]);
/**
 * Request headers that show how data was sent; cookies and credentials are
 * never kept. Only the Network domain is used: enabling Runtime on a page
 * is what anti-bot kits detect, and a kit that detects us hides its payload.
 */
const KEPT_REQUEST_HEADERS = new Set(["content-type", "origin", "referer", "user-agent", "x-requested-with"]);

/**
 * The raw CDP target type. Puppeteer's `Target.type()` folds out-of-process
 * iframes and dedicated workers into `"other"`, which hid every cross-origin
 * kit frame (e.g. a loader page framing `stop.relizedog.com`) from the recorder.
 */
function cdpTargetType(target: Target): string {
	const info = (target as unknown as { _getTargetInfo?: () => { type?: string } })._getTargetInfo?.();
	return info?.type ?? target.type();
}

/** Records outbound payloads from every page/worker target while Skyvern drives the browser. */
export class ExfiltrationNetworkRecorder {
	private readonly requests: CapturedNetworkRequest[] = [];
	private readonly sessions = new Set<CDPSession>();
	private readonly attachedTargets = new Set<string>();
	private capturedBytes = 0;
	private browser?: Browser;
	private targetHandler?: (target: Target) => void;

	async start(browser: Browser): Promise<void> {
		this.browser = browser;
		this.targetHandler = (target) => { void this.attach(target); };
		browser.on("targetcreated", this.targetHandler);
		browser.on("targetchanged", this.targetHandler);
		await Promise.all(browser.targets().map((target) => this.attach(target)));
	}

	private push(request: CapturedNetworkRequest): boolean {
		if (this.requests.length >= MAX_CAPTURE_COUNT) return false;
		const size = Buffer.byteLength(JSON.stringify(request));
		if (this.capturedBytes + size > MAX_CAPTURE_BYTES) return false;
		this.capturedBytes += size;
		this.requests.push(request);
		return true;
	}

	private async attach(target: Target): Promise<void> {
		const targetId = (target as unknown as { _targetId?: string })._targetId ?? `${target.type()}:${target.url()}`;
		if (this.attachedTargets.has(targetId)) return;
		if (!NETWORK_TARGET_TYPES.has(cdpTargetType(target))) return;
		this.attachedTargets.add(targetId);
		let session: CDPSession;
		try {
			session = await target.createCDPSession();
			await session.send("Network.enable", { maxPostDataSize: MAX_VALUE_BYTES });
		} catch {
			this.attachedTargets.delete(targetId);
			return;
		}
		this.sessions.add(session);
		type CdpResponse = { status: number; statusText?: string; remoteIPAddress?: string; mimeType?: string };
		const pending = new Map<string, CapturedNetworkRequest>();
		/** The server's answer to a recorded request; a redirect answers it as well as a final response. */
		const answer = (requestId: string, response: CdpResponse) => {
			const request = pending.get(requestId);
			if (!request) return;
			pending.delete(requestId);
			request.response = {
				status: response.status,
				...(response.statusText ? { statusText: response.statusText } : {}),
				receivedAt: new Date().toISOString(),
				...(response.remoteIPAddress ? { remoteAddress: response.remoteIPAddress } : {}),
				...(response.mimeType ? { mimeType: response.mimeType } : {}),
			};
		};
		session.on("Network.responseReceived", (event: { requestId: string; response: CdpResponse }) => answer(event.requestId, event.response));
		const webSockets = new Map<string, string>();
		session.on("Network.webSocketCreated", (event: { requestId: string; url: string }) => webSockets.set(event.requestId, event.url));
		session.on("Network.webSocketFrameSent", (event: { requestId: string; response: { payloadData?: string } }) => {
			const url = webSockets.get(event.requestId);
			if (!url) return;
			this.push({ timestamp: new Date().toISOString(), method: "WEBSOCKET", url, webSocketPayload: bounded(event.response.payloadData) });
		});
		session.on("Network.requestWillBeSent", (event: {
			requestId: string;
			type?: string;
			documentURL?: string;
			redirectResponse?: CdpResponse;
			request: { url: string; method: string; postData?: string; hasPostData?: boolean; headers?: Record<string, string> };
		}) => {
			// A redirect reuses the request id: the earlier request got this answer.
			if (event.redirectResponse) answer(event.requestId, event.redirectResponse);
			const sentAt = new Date().toISOString();
			const headers = Object.fromEntries(Object.entries(event.request.headers ?? {})
				.filter(([name]) => KEPT_REQUEST_HEADERS.has(name.toLowerCase()))
				.map(([name, value]) => [name.toLowerCase(), String(value).slice(0, 1_000)]));
			const record = (postData?: string) => {
				const request: CapturedNetworkRequest = {
					timestamp: sentAt,
					url: event.request.url,
					method: event.request.method,
					...(event.type ? { resourceType: event.type } : {}),
					...(bounded(postData) ? { postData: bounded(postData) } : {}),
					...(event.documentURL ? { documentUrl: event.documentURL } : {}),
					...(Object.keys(headers).length ? { requestHeaders: headers } : {}),
				};
				if (this.push(request)) pending.set(event.requestId, request);
			};
			if (event.request.postData || !event.request.hasPostData) {
				record(event.request.postData);
				return;
			}
			void session.send("Network.getRequestPostData", { requestId: event.requestId })
				.then((result: { postData?: string }) => record(result.postData))
				.catch(() => record());
		});
	}

	/** Requests recorded so far, without detaching; used to wait for a known request to arrive. */
	snapshot(): CapturedNetworkRequest[] {
		return structuredClone(this.requests);
	}

	async stop(): Promise<CapturedNetworkRequest[]> {
		if (this.browser && this.targetHandler) {
			this.browser.off("targetcreated", this.targetHandler);
			this.browser.off("targetchanged", this.targetHandler);
		}
		await Promise.all([...this.sessions].map((session) => session.detach().catch(() => undefined)));
		this.sessions.clear();
		return structuredClone(this.requests);
	}
}
