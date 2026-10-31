import { createHash } from "node:crypto";

import { serviceIdentity } from "../constants";
import type { WebsiteNavigationHop } from "../website_types";
import { stampAddressBar } from "./address_bar";
import { timestampEvidence, type EvidenceTimestamp } from "./timestamp";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export type EvidenceFile = { name: string; mimeType: string; bytes: Buffer };

/** What one live website capture saw, and how. */
export type WebsiteCaptureFacts = {
	caseId: string;
	submittedUrl: string;
	/** The page whose content, screenshot and archive were captured. */
	capturedUrl: string;
	capturedAt: Date;
	route?: string;
	navigationHops: WebsiteNavigationHop[];
	screenshotPng?: Buffer;
	mhtml: Buffer;
};

export type WebsiteEvidencePackage = {
	/** The screenshot with the address bar drawn above it; the raw one stays unchanged. */
	stampedScreenshotPng?: Buffer;
	/** Canonical JSON naming every file by SHA-256; this is what the timestamp covers. */
	manifest: Buffer;
	timestamp?: EvidenceTimestamp;
};

/** The order-stable JSON the timestamp covers, so anyone can reproduce its hash. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * Build the evidence for one capture the way courts and abuse desks weigh it:
 * the page with its URL and capture time visibly stamped, a manifest that
 * names every file by SHA-256 together with the URL, time, route and
 * navigation, and an RFC 3161 token from an independent authority proving the
 * manifest existed then. Any later change to a file breaks its hash.
 */
export async function buildWebsiteEvidence(
	facts: WebsiteCaptureFacts,
	dependencies: { timestamp?: typeof timestampEvidence } = {},
): Promise<WebsiteEvidencePackage> {
	const screenshotSha256 = facts.screenshotPng ? sha256(facts.screenshotPng) : undefined;
	// A screenshot that does not decode is still recorded by hash; it only gets no address bar.
	const stampedScreenshotPng = facts.screenshotPng && screenshotSha256
		? await stampAddressBar(facts.screenshotPng, {
			url: facts.capturedUrl,
			capturedAt: facts.capturedAt,
			route: facts.route ?? "unknown route",
			caseId: facts.caseId,
			screenshotSha256,
		}).catch((error: unknown) => {
			console.warn(`The screenshot of case ${facts.caseId} could not be stamped: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		})
		: undefined;
	const files: Array<{ name: string; mimeType: string; sha256: string; size: number }> = [
		...(facts.screenshotPng ? [{ name: "website.png", mimeType: "image/png", sha256: screenshotSha256!, size: facts.screenshotPng.byteLength }] : []),
		...(stampedScreenshotPng ? [{ name: "website-stamped.png", mimeType: "image/png", sha256: sha256(stampedScreenshotPng), size: stampedScreenshotPng.byteLength }] : []),
		{ name: "website.mhtml", mimeType: "text/mhtml", sha256: sha256(facts.mhtml), size: facts.mhtml.byteLength },
	];
	const manifest = Buffer.from(`${canonicalJson({
		format: "phishing.support/evidence-manifest@1",
		collector: { name: serviceIdentity.name, url: serviceIdentity.url },
		case: { id: facts.caseId, url: `${serviceIdentity.url}/submissions/${facts.caseId}` },
		capture: {
			submittedUrl: facts.submittedUrl,
			capturedUrl: facts.capturedUrl,
			capturedAt: facts.capturedAt.toISOString(),
			route: facts.route,
			navigation: facts.navigationHops.map(({ index, url, status, redirectTo, contentCaptured }) => ({ index, url, status, redirectTo, contentCaptured })),
		},
		files,
		hashAlgorithm: "SHA-256",
	})}\n`, "utf8");
	const timestamp = await (dependencies.timestamp ?? timestampEvidence)(manifest);
	return { ...(stampedScreenshotPng ? { stampedScreenshotPng } : {}), manifest, ...(timestamp ? { timestamp } : {}) };
}

/** The files a package adds next to the raw screenshot and MHTML. */
export function websiteEvidenceFiles(evidence: WebsiteEvidencePackage): EvidenceFile[] {
	return [
		...(evidence.stampedScreenshotPng ? [{ name: "website-stamped.png", mimeType: "image/png", bytes: evidence.stampedScreenshotPng }] : []),
		{ name: "evidence-manifest.json", mimeType: "application/json", bytes: evidence.manifest },
		...(evidence.timestamp ? [{ name: "evidence-manifest.tsr", mimeType: "application/timestamp-reply", bytes: evidence.timestamp.token }] : []),
	];
}
