import { createHash } from "node:crypto";

import { parse } from "mhtml-to-html";

import { registrableDomain } from "../abuse/security";
import { ArtifactsEntity } from "../db/entities/artifacts";
import { latestArtifactNamed, websiteCaptureFileNames } from "../website/capture_files";

/** Below this a page body is too generic (an error, parking or loader page) to tie two sites together. */
const MIN_BODY_BYTES = 2_048;
/** Below this many tags a page's structure is too generic to tie two sites together. */
const MIN_STRUCTURE_TAGS = 30;

/**
 * Pages a hosting provider shows in front of the site instead of it: they
 * are the provider's, the same on every site behind it, so they link nothing.
 */
const PROVIDER_PAGES = [
	// Cloudflare's "Just a moment..." browser check.
	/<title>\s*Just a moment\.\.\.\s*<\/title>|id="challenge-success-text"/i,
];

export type PageFingerprints = {
	/** The body, byte for byte apart from the site's own address: the same page. */
	body?: { sha256: string; size: number };
	/** The sequence of tags in the body, without text or attributes: the same page built from one template whose words change. */
	structure?: { sha256: string; size: number; tags: number };
};

function escaped(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * The tags of a body in order, by name only: what a kit's template builds,
 * whatever words it fills in (generated SEO text, another brand name) and
 * whatever class names it randomizes on each render. Scripts and styles
 * count as tags; their contents and comments do not.
 */
function bodyStructure(body: string): string[] {
	const markup = body.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "<$1></$1>");
	return [...markup.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b[^>]*>/gi)].map((match) => `${match[1]}${match[2]!.toLowerCase()}`);
}

/**
 * What the captured page shows about the kit behind it, as the kit renders
 * it on any of its domains: the HTML the browser stored, cut to its `<body>`
 * (a deployment's `<head>` differs: a canonical link, a tracking tag).
 *
 * - `body`: the body with the site's host name and registrable domain masked
 *   and the capture's random part ids (`cid:…`) removed. It ties the 161
 *   domains of one Vietnamese "TikTok coin" kit together.
 * - `structure`: the body's tags alone. It ties pages built from one template
 *   whose text differs: gambling SEO pages on hijacked domains, each naming
 *   another brand, or a USPS kit that randomizes its class names.
 *
 * A provider's interstitial (Cloudflare's browser check) is not the site's
 * page and has neither.
 */
export function pageFingerprints(mhtml: Buffer, siteUrl: string): PageFingerprints {
	let host: string;
	try {
		host = new URL(siteUrl).hostname.toLowerCase();
	} catch {
		return {};
	}
	let html: unknown;
	try {
		const archive = parse(new Uint8Array(mhtml));
		html = archive.resources[archive.index]?.data;
	} catch {
		return {};
	}
	if (typeof html !== "string" || PROVIDER_PAGES.some((page) => page.test(html as string))) return {};
	const body = /<body[\s>][\s\S]*<\/body>/i.exec(html)?.[0] ?? html;
	const fingerprints: PageFingerprints = {};

	const size = Buffer.byteLength(body);
	if (size >= MIN_BODY_BYTES) {
		let masked = body.replace(/cid:[^"'\s)>]+/g, "cid:");
		for (const name of new Set([host, registrableDomain(host) ?? host])) masked = masked.replace(new RegExp(escaped(name), "gi"), "{host}");
		fingerprints.body = { sha256: sha256(masked), size };
	}
	const tags = bodyStructure(body);
	if (tags.length >= MIN_STRUCTURE_TAGS) fingerprints.structure = { sha256: sha256(tags.join(" ")), size, tags: tags.length };
	return fingerprints;
}

/** The fingerprints of the site's first capture, the page that was reported. */
export async function loadPageFingerprints(submissionId: bigint, siteUrl: string): Promise<PageFingerprints> {
	const meta = latestArtifactNamed(await ArtifactsEntity.listForSubmission(submissionId), websiteCaptureFileNames(0).mhtml);
	const artifact = meta ? await ArtifactsEntity.get(BigInt(meta.id)) : undefined;
	return artifact ? pageFingerprints(Buffer.from(artifact.blob), siteUrl) : {};
}
