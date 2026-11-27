import { convert } from "mhtml-to-html";

import { isSameWebsite, websiteSite } from "../info/site";
import { capturedDocumentContent } from "./text";
import type { MhtmlSnapshotOptions, WebsiteArchiveResult } from "./types";

/** Read a top-level MHTML header; MIME-part headers must never override capture metadata. */
function getMhtmlHeader(snapshot: Buffer, name: string): string | undefined {
	const crlfHeaderEnd = snapshot.indexOf("\r\n\r\n");
	const lfHeaderEnd = snapshot.indexOf("\n\n");
	const headerEnd = crlfHeaderEnd >= 0 ? crlfHeaderEnd : lfHeaderEnd;
	const preamble = snapshot
		.subarray(0, headerEnd < 0 ? snapshot.byteLength : headerEnd)
		.toString("latin1")
		.replace(/\r?\n[\t ]+/g, " ");
	return preamble.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))?.[1]?.trim();
}

/** Reads the capture time emitted by Chromium's MHTML snapshot writer. */
export function getMhtmlArchiveDate(snapshot: Buffer): Date | undefined {
	const value = getMhtmlHeader(snapshot, "Date");
	if (!value) return undefined;
	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
}

/** Reads Chromium's document URL so a retained snapshot is attributed to the page it captured. */
export function getMhtmlArchiveLocation(snapshot: Buffer): string | undefined {
	const value = getMhtmlHeader(snapshot, "Snapshot-Content-Location");
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

/** A capture read from an MHTML snapshot, without any browser: a reporter's upload, a stored capture, a live capture's own snapshot. */
export async function parseMhtmlSnapshot(options: MhtmlSnapshotOptions): Promise<WebsiteArchiveResult> {
	const declaredDocumentUrl = getMhtmlArchiveLocation(options.mhtmlSnapshot);
	const requestedUrl = new URL(options.url);
	const attributionError = !options.archivedUrl && !options.trustMhtmlDocumentLocation && declaredDocumentUrl && !isSameWebsite(declaredDocumentUrl, requestedUrl)
		? `The uploaded MHTML declares ${websiteSite(declaredDocumentUrl)}, but the submitted target is ${websiteSite(requestedUrl)}.`
		: undefined;
	const documentUrl = attributionError
		? options.url
		: options.archivedUrl ?? (options.trustMhtmlDocumentLocation ? declaredDocumentUrl : undefined) ?? options.url;
	const { hostname } = new URL(documentUrl);
	const navigationHops = options.navigationHops?.length
		? options.navigationHops
		: attributionError
			? [{ index: 0, url: options.url, hostname: requestedUrl.hostname, status: null, contentCaptured: false }]
			: documentUrl === options.url
				? [{ index: 0, url: documentUrl, hostname, status: null, contentCaptured: true }]
				: [
						{ index: 0, url: options.url, hostname: requestedUrl.hostname, status: null, redirectTo: documentUrl, contentCaptured: false },
						{ index: 1, url: documentUrl, hostname, status: null, contentCaptured: true },
					];
	const { data } = await convert(options.mhtmlSnapshot, {
		enableScripts: false,
		fetchMissingResources: false,
	});
	const { html, text } = capturedDocumentContent(data);
	return {
		requestedUrl: options.url,
		url: documentUrl,
		hostname,
		navigationHops,
		archivedAt: getMhtmlArchiveDate(options.mhtmlSnapshot) ?? new Date(),
		mhtml: options.mhtmlSnapshot,
		html: Buffer.from(html, "utf-8"),
		text: Buffer.from(text, "utf-8"),
		...(attributionError ? { attributionError } : {}),
		...(options.verificationGate ? { verificationGate: options.verificationGate } : {}),
		...(options.kitResources?.length ? { kitResources: options.kitResources } : {}),
		...(options.hiddenFrames?.length ? { hiddenFrames: options.hiddenFrames } : {}),
		...(options.device && options.device !== "desktop" ? { device: options.device } : {}),
	};
}
