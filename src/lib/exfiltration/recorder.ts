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

	private push(request: CapturedNetworkRequest): void {
		if (this.requests.length >= MAX_CAPTURE_COUNT) return;
		const size = Buffer.byteLength(JSON.stringify(request));
		if (this.capturedBytes + size > MAX_CAPTURE_BYTES) return;
		this.capturedBytes += size;
		this.requests.push(request);
	}

	private async attach(target: Target): Promise<void> {
		const targetId = (target as unknown as { _targetId?: string })._targetId ?? `${target.type()}:${target.url()}`;
		if (this.attachedTargets.has(targetId)) return;
		if (!["page", "iframe", "service_worker", "shared_worker", "worker"].includes(target.type())) return;
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
			request: { url: string; method: string; postData?: string; hasPostData?: boolean };
		}) => {
			const record = (postData?: string) => this.push({
				timestamp: new Date().toISOString(),
				url: event.request.url,
				method: event.request.method,
				...(event.type ? { resourceType: event.type } : {}),
				...(bounded(postData) ? { postData: bounded(postData) } : {}),
			});
			if (event.request.postData || !event.request.hasPostData) {
				record(event.request.postData);
				return;
			}
			void session.send("Network.getRequestPostData", { requestId: event.requestId })
				.then((result: { postData?: string }) => record(result.postData))
				.catch(() => record());
		});
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
