import { createHash } from "node:crypto";

import type { Frame, HTTPRequest, HTTPResponse, Page } from "rebrowser-puppeteer-core";

import { exploitLoaderSignals, type FrameCode } from "./malware/exploit_loader";
import type { WebsiteFrameRequest, WebsiteFrameResource, WebsiteHiddenFrame } from "./website_types";

/** Frames kept per capture; a page needs only one to run its loader. */
const MAX_HIDDEN_FRAMES = 6;
/** Responses kept per frame. */
const MAX_FRAME_RESOURCES = 40;
/** Requests other than GET kept per frame. */
const MAX_FRAME_REQUESTS = 20;
/** A frame document's source as stored and given to the classifier. */
export const MAX_HIDDEN_FRAME_SOURCE_CHARACTERS = 64 * 1024;
/** A script read for signals; exploit stages run to several hundred KB. */
const MAX_CODE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BODY_CHARACTERS = 2_000;
/** Resource types whose bodies are code or a document the signals read. */
const CODE_TYPES = new Set(["document", "script", "fetch", "xhr"]);

type FrameResponse = { resource: Promise<WebsiteFrameResource | undefined>; code: Promise<FrameCode | undefined> };
type FrameTraffic = { responses: FrameResponse[]; requests: WebsiteFrameRequest[]; document?: Promise<{ body: Buffer; url: string } | undefined> };

/** Everything the page's frames other than the main frame received and sent, per frame. */
export type FrameTrafficRecorder = { traffic: Map<Frame, FrameTraffic> };

function frameOf(request: HTTPRequest): Frame | null {
	try {
		return request.frame();
	} catch {
		return null;
	}
}

/**
 * Record each frame's responses and its requests other than GET, from the
 * moment the page opens. Chromium's MHTML keeps no scripts, so this is the
 * only place the code a hidden frame ran survives.
 */
export function recordFrameTraffic(page: Page): FrameTrafficRecorder {
	const traffic = new Map<Frame, FrameTraffic>();
	const of = (frame: Frame) => {
		let entry = traffic.get(frame);
		if (!entry) traffic.set(frame, entry = { responses: [], requests: [] });
		return entry;
	};
	page.on("response", (response: HTTPResponse) => {
		const request = response.request();
		const frame = frameOf(request);
		if (!frame || frame === page.mainFrame()) return;
		const entry = of(frame);
		const type = request.resourceType();
		const status = response.status();
		const body = status >= 300 && status < 400 ? Promise.resolve(undefined) : response.buffer().catch(() => undefined);
		if (type === "document" && request.isNavigationRequest()) {
			entry.document = body.then((bytes) => (bytes ? { body: bytes, url: response.url() } : undefined));
		}
		if (entry.responses.length >= MAX_FRAME_RESOURCES) return;
		entry.responses.push({
			resource: body.then((bytes) => ({
				url: response.url(),
				type,
				status,
				size: bytes?.byteLength ?? 0,
				sha256: createHash("sha256").update(bytes ?? Buffer.alloc(0)).digest("hex"),
			})),
			code: body.then((bytes) => (bytes && CODE_TYPES.has(type) && bytes.byteLength <= MAX_CODE_BYTES ? { url: response.url(), text: bytes.toString("utf8") } : undefined)),
		});
	});
	page.on("request", (request: HTTPRequest) => {
		if (request.method() === "GET") return;
		const frame = frameOf(request);
		if (!frame || frame === page.mainFrame()) return;
		const entry = of(frame);
		if (entry.requests.length >= MAX_FRAME_REQUESTS) return;
		const body = request.postData();
		entry.requests.push({ url: request.url(), method: request.method(), ...(body ? { body: body.slice(0, MAX_REQUEST_BODY_CHARACTERS) } : {}) });
	});
	return { traffic };
}

/**
 * Why a visitor cannot see the frame element, judged in its parent's
 * document: no box (display/visibility/opacity), a box of at most a pixel,
 * or a box entirely outside the page.
 */
function hiddenReason(element: Element): string | null {
	const style = getComputedStyle(element);
	if (style.display === "none") return "display: none";
	if (style.visibility === "hidden" || style.visibility === "collapse") return "visibility: hidden";
	if (Number(style.opacity) === 0) return "opacity: 0";
	const box = element.getBoundingClientRect();
	if (box.width <= 1 || box.height <= 1) return `${Math.round(box.width)}×${Math.round(box.height)} size`;
	const root = document.documentElement;
	const pageWidth = Math.max(innerWidth, root.scrollWidth);
	const pageHeight = Math.max(innerHeight, root.scrollHeight);
	if (box.right <= 0 || box.bottom <= 0 || box.left >= pageWidth || box.top >= pageHeight) return "positioned off-screen";
	return null;
}

async function frameHiddenBy(frame: Frame): Promise<string | null> {
	const element = await frame.frameElement().catch(() => null);
	if (!element) return null;
	try {
		return await element.evaluate(hiddenReason);
	} catch {
		return null;
	} finally {
		await element.dispose().catch(() => undefined);
	}
}

/**
 * The frames of the page as it stands that no visitor can see, each with the
 * document it loaded, what it received and sent, and what its code was found
 * to do. A frame inside a hidden frame is hidden too.
 */
export async function hiddenFrames(page: Page, recorder: FrameTrafficRecorder, userAgent: string): Promise<WebsiteHiddenFrame[]> {
	const frames: WebsiteHiddenFrame[] = [];
	// Depth first in document order, so a frame's ref follows its parent's.
	const tree = (frame: Frame): Frame[] => frame.childFrames().flatMap((child) => [child, ...tree(child)]);
	const hiddenBy = new Map<Frame, string>();
	for (const frame of tree(page.mainFrame())) {
		if (frame.detached) continue;
		const parent = frame.parentFrame();
		const reason = (parent && hiddenBy.has(parent) ? `inside a hidden frame (${hiddenBy.get(parent)})` : null) ?? await frameHiddenBy(frame);
		if (!reason) continue;
		hiddenBy.set(frame, reason);
		if (frames.length >= MAX_HIDDEN_FRAMES) continue;

		const traffic = recorder.traffic.get(frame);
		const received = await traffic?.document;
		const url = received?.url ?? frame.url();
		if (!/^https?:/i.test(url)) continue;
		const documentBytes = received?.body ?? Buffer.from(await frame.content().catch(() => ""), "utf8");
		if (documentBytes.byteLength === 0) continue;
		const responses = traffic?.responses ?? [];
		const resources = (await Promise.all(responses.map((response) => response.resource))).filter((resource): resource is WebsiteFrameResource => Boolean(resource));
		const scripts = (await Promise.all(responses.map((response) => response.code))).filter((code): code is FrameCode => Boolean(code) && code!.url !== url);
		const source = documentBytes.toString("utf8");
		const sentRequests = traffic?.requests ?? [];
		frames.push({
			ref: `frame${frames.length + 1}`,
			url,
			hiddenBy: reason,
			sha256: createHash("sha256").update(documentBytes).digest("hex"),
			size: documentBytes.byteLength,
			source: source.slice(0, MAX_HIDDEN_FRAME_SOURCE_CHARACTERS),
			resources,
			sentRequests,
			signals: exploitLoaderSignals({ frameUrl: url, code: [{ url, text: source }, ...scripts], resources, sentRequests }),
			userAgent,
		});
	}
	return frames;
}
