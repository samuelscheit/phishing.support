import type { Browser, CDPSession, Protocol } from "rebrowser-puppeteer-core";

import { sendBeforeRun } from "../browser/cdp";
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
/** Target types whose documents read navigator.platform from every session attached to them. */
const DOCUMENT_TARGET_TYPES = new Set(["page", "iframe"]);
/**
 * Request headers that show how data was sent; cookies and credentials are
 * never kept. Only the Network domain is used: enabling Runtime on a page
 * is what anti-bot kits detect, and a kit that detects us hides its payload.
 */
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } as const;
type AttachedEvent = { sessionId: string; targetInfo: { targetId: string; type: string } };
const KEPT_REQUEST_HEADERS = new Set(["content-type", "origin", "referer", "user-agent", "x-requested-with"]);

/** Records outbound payloads from every page/worker target while the visiting agent drives the browser. */
export class ExfiltrationNetworkRecorder {
	private readonly requests: CapturedNetworkRequest[] = [];
	private readonly sessions = new Set<CDPSession>();
	private readonly attachedTargets = new Set<string>();
	private capturedBytes = 0;
	private stopped = false;
	private userAgentOverride?: Protocol.Emulation.SetUserAgentOverrideRequest;

	/**
	 * Auto-attaches to every target of the browser, and recursively to each
	 * target's children (out-of-process frames, workers). Each target is held
	 * until its Network domain is enabled, so even a first script that posts
	 * immediately is recorded.
	 */
	async start(browser: Browser, options: {
		/**
		 * The identity the visit presents. Chromium resets a document's
		 * navigator.platform when a session without it attaches, so every
		 * session this recorder holds on a page or frame presents it too.
		 */
		userAgentOverride?: Protocol.Emulation.SetUserAgentOverrideRequest;
	} = {}): Promise<void> {
		this.userAgentOverride = options.userAgentOverride;
		const root = await browser.target().createCDPSession();
		this.sessions.add(root);
		this.followChildren(root);
		await root.send("Target.setAutoAttach", AUTO_ATTACH);
	}

	/** Attach to every child target the session reports, existing and future. */
	private followChildren(session: CDPSession): void {
		session.on("Target.attachedToTarget", (event: AttachedEvent) => {
			const child = session.connection()?.session(event.sessionId);
			if (child) this.adopt(child, event);
		});
	}

	private adopt(session: CDPSession, { targetInfo }: AttachedEvent): void {
		const release = () => { void sendBeforeRun(session, "Runtime.runIfWaitingForDebugger"); };
		if (this.stopped || this.attachedTargets.has(targetInfo.targetId) || !NETWORK_TARGET_TYPES.has(targetInfo.type)) {
			// Not recorded: let it run, and drop the session this recorder holds.
			release();
			void session.detach().catch(() => undefined);
			return;
		}
		this.attachedTargets.add(targetInfo.targetId);
		this.sessions.add(session);
		this.record(session);
		this.followChildren(session);
		// Commands a held target answers only once it runs are not awaited; they take effect in order, before it runs.
		if (this.userAgentOverride && DOCUMENT_TARGET_TYPES.has(targetInfo.type)) void sendBeforeRun(session, "Emulation.setUserAgentOverride", this.userAgentOverride);
		void sendBeforeRun(session, "Network.enable", { maxPostDataSize: MAX_VALUE_BYTES });
		void sendBeforeRun(session, "Target.setAutoAttach", AUTO_ATTACH);
		release();
	}

	private push(request: CapturedNetworkRequest): boolean {
		// A session its owner holds may still report after the recording ended.
		if (this.stopped) return false;
		if (this.requests.length >= MAX_CAPTURE_COUNT) return false;
		const size = Buffer.byteLength(JSON.stringify(request));
		if (this.capturedBytes + size > MAX_CAPTURE_BYTES) return false;
		this.capturedBytes += size;
		this.requests.push(request);
		return true;
	}

	private record(session: CDPSession): void {
		type CdpResponse = { status: number; statusText?: string; mimeType?: string };
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
		this.stopped = true;
		await Promise.all([...this.sessions].map((session) => session.detach().catch(() => undefined)));
		this.sessions.clear();
		return structuredClone(this.requests);
	}
}
