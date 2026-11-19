import { createHash } from "node:crypto";

import { parse } from "mhtml-to-html";

import { registrableDomain } from "../abuse/security";
import { ArtifactsEntity } from "../db/entities";
import { latestArtifactNamed, websiteCaptureFileNames } from "../website_capture_files";

/** Below this a page body is too generic (an error, parking or loader page) to tie two sites together. */
const MIN_BODY_BYTES = 2_048;

function escaped(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The captured page's body, as the kit renders it on any of its domains:
 * the HTML the browser stored, cut to its `<body>`, with the site's host name
 * and registrable domain masked and the capture's random part ids (`cid:…`)
 * removed. Sites a kit deploys under new domains then have the same hash,
 * also where the capture holds no script files (Chrome's MHTML drops them)
 * and where a deployment's `<head>` differs (a canonical link, a tracking
 * tag, a stylesheet line), as with the 161 domains of one Vietnamese
 * "TikTok coin" kit.
 */
export function pageDocumentFingerprint(mhtml: Buffer, siteUrl: string): { sha256: string; size: number } | undefined {
	let host: string;
	try {
		host = new URL(siteUrl).hostname.toLowerCase();
	} catch {
		return undefined;
	}
	let html: unknown;
	try {
		const archive = parse(new Uint8Array(mhtml));
		html = archive.resources[archive.index]?.data;
	} catch {
		return undefined;
	}
	if (typeof html !== "string") return undefined;
	let body = /<body[\s>][\s\S]*<\/body>/i.exec(html)?.[0] ?? html;
	const size = Buffer.byteLength(body);
	if (size < MIN_BODY_BYTES) return undefined;
	body = body.replace(/cid:[^"'\s)>]+/g, "cid:");
	for (const name of new Set([host, registrableDomain(host) ?? host])) body = body.replace(new RegExp(escaped(name), "gi"), "{host}");
	return { sha256: createHash("sha256").update(body).digest("hex"), size };
}

/** The fingerprint of the site's first capture, the page that was reported. */
export async function loadPageDocumentFingerprint(submissionId: bigint, siteUrl: string): Promise<{ sha256: string; size: number } | undefined> {
	const meta = latestArtifactNamed(await ArtifactsEntity.listForSubmission(submissionId), websiteCaptureFileNames(0).mhtml);
	const artifact = meta ? await ArtifactsEntity.get(BigInt(meta.id)) : undefined;
	return artifact ? pageDocumentFingerprint(Buffer.from(artifact.blob), siteUrl) : undefined;
}
